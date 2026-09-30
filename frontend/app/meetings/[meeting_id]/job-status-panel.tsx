"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { Job } from "@/lib/api";

import styles from "./page.module.css";

interface JobStatusPanelProps {
  meetingId: string;
  initialJobs: Job[];
}

function jobLabel(job: Job): string {
  if (job.type === "preprocess_media") return "動画変換";
  if (job.type === "transcribe") return "文字起こし";
  if (job.type === "transcribe_live") return "Live文字起こし";
  if (job.type === "generate_thumbnails") return "サムネイル生成";
  if (job.type === "ask_meeting") return "会議への質問";
  return "AI解析";
}

const jobTypeOrder: Job["type"][] = [
  "preprocess_media",
  "transcribe",
  "transcribe_live",
  "generate_thumbnails",
  "analyze",
  "ask_meeting",
];

function newestFirst(left: Job, right: Job): number {
  const difference = Date.parse(right.created_at) - Date.parse(left.created_at);
  return Number.isNaN(difference) ? 0 : difference;
}

export function groupJobsForDisplay(jobs: Job[]): {
  currentJobs: Job[];
  historyJobs: Job[];
} {
  const sortedJobs = [...jobs].sort(newestFirst);
  const latestByType = new Map<Job["type"], Job>();

  for (const job of sortedJobs) {
    if (!latestByType.has(job.type)) latestByType.set(job.type, job);
  }
  const unresolvedLiveFailure = sortedJobs.find(
    (job) => job.type === "transcribe_live" && job.status === "failed",
  );
  if (unresolvedLiveFailure) {
    latestByType.set("transcribe_live", unresolvedLiveFailure);
  }

  const currentJobs = [...latestByType.values()].sort(
    (left, right) => jobTypeOrder.indexOf(left.type) - jobTypeOrder.indexOf(right.type),
  );
  const currentIds = new Set(currentJobs.map((job) => job.id));

  return {
    currentJobs,
    historyJobs: sortedJobs.filter((job) => !currentIds.has(job.id)),
  };
}

function formatWindowTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function jobWindowLabel(job: Job): string | null {
  if (
    job.type !== "transcribe_live" ||
    job.realtime_commit_start_ms === null ||
    job.realtime_window_end_ms === null
  ) {
    return null;
  }
  return `${formatWindowTime(job.realtime_commit_start_ms)}–${formatWindowTime(job.realtime_window_end_ms)} の区間`;
}

function jobStatusLabel(job: Job): string {
  if (job.status === "queued") return "待機中";
  if (job.status === "running") return "処理中";
  if (job.status === "completed") return "完了";
  return "失敗";
}

function jobFailureSummary(job: Job): string {
  const message = job.error_message ?? "";
  if (job.type === "ask_meeting") {
    if (/HTTP|接続|timeout|timed out/i.test(message)) {
      return "AIサービスからエラーが返されました";
    }
    if (/JSON|Evidence|Field required|validation/i.test(message)) {
      return "AIの回答形式を確認できませんでした";
    }
    return "会議への回答を作成できませんでした";
  }
  if (job.type === "analyze") {
    if (/HTTP|接続|timeout|timed out/i.test(message)) {
      return "AIサービスからエラーが返されました";
    }
    if (/JSON|議事録形式|Field required|validation/i.test(message)) {
      return "AIの回答形式を確認できませんでした";
    }
    return "AI解析を完了できませんでした";
  }
  return `${jobLabel(job)}を完了できませんでした`;
}

function hasActiveJob(jobs: Job[]): boolean {
  return jobs.some((job) => job.status === "queued" || job.status === "running");
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: string };
    if (body.detail) return body.detail;
  } catch {
    // Use the status-based message for a non-JSON response.
  }
  return `処理状況を更新できませんでした (${response.status})`;
}

export function JobStatusPanel({ meetingId, initialJobs }: JobStatusPanelProps) {
  const router = useRouter();
  const [jobs, setJobs] = useState(initialJobs);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const jobsRef = useRef(initialJobs);

  const refreshJobs = useCallback(async (showIndicator = false) => {
    if (showIndicator) setRefreshing(true);
    try {
      const response = await fetch(`/api/v1/meetings/${meetingId}/jobs`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const nextJobs = await response.json() as Job[];
      const hadActiveJob = hasActiveJob(jobsRef.current);
      jobsRef.current = nextJobs;
      setJobs(nextJobs);
      setError("");
      if (hadActiveJob && !hasActiveJob(nextJobs)) {
        router.refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "処理状況を更新できませんでした");
    } finally {
      if (showIndicator) setRefreshing(false);
    }
  }, [meetingId, router]);

  const polling = hasActiveJob(jobs);
  const { currentJobs, historyJobs } = groupJobsForDisplay(jobs);
  const failedCount = currentJobs.filter((job) => job.status === "failed").length;
  const statusSummary = polling
    ? "処理中"
    : failedCount > 0
      ? `${failedCount}工程で確認が必要`
      : currentJobs.length > 0
        ? "すべて完了"
        : "処理なし";
  const summaryStatus = polling ? "active" : failedCount > 0 ? "failed" : "idle";

  useEffect(() => {
    if (!polling) return;
    const intervalId = window.setInterval(() => void refreshJobs(), 2000);
    return () => window.clearInterval(intervalId);
  }, [polling, refreshJobs]);

  async function retryJob(jobId: string) {
    setRetryingJobId(jobId);
    setError("");
    try {
      const response = await fetch(`/api/v1/jobs/${jobId}/retry`, { method: "POST" });
      if (!response.ok) throw new Error(await errorMessage(response));
      const retriedJob = await response.json() as Job;
      const nextJobs = jobsRef.current.map((job) =>
        job.id === retriedJob.id ? retriedJob : job,
      );
      jobsRef.current = nextJobs;
      setJobs(nextJobs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "再試行できませんでした");
    } finally {
      setRetryingJobId(null);
    }
  }

  return (
    <section className={styles.jobsSection}>
      <details open={polling || failedCount > 0}>
        <summary className={styles.jobToggle}>
          <div>
            <strong>処理状況</strong>
          </div>
          <em data-status={summaryStatus}>{statusSummary}</em>
        </summary>
        <div className={styles.jobContent}>
          <div className={styles.jobToolbar}>
            <p>ファイル変換・文字起こし・AI解析</p>
            <button disabled={refreshing} type="button" onClick={() => void refreshJobs(true)}>
              {refreshing ? "更新中" : "更新"}
            </button>
          </div>
          {error && <p className={styles.jobError} role="alert">{error}</p>}
          {jobs.length === 0 ? (
            <p className={styles.empty}>ファイルをアップロードすると処理状況が表示されます。</p>
          ) : (
            <>
            <div className={styles.jobs}>
              {currentJobs.map((job) => (
                <article key={job.id} className={styles.job}>
                  <div><strong>{jobLabel(job)}</strong><span data-status={job.status}>{jobStatusLabel(job)}</span></div>
                  {jobWindowLabel(job) && <small>{jobWindowLabel(job)}</small>}
                  {(job.status === "queued" || job.status === "running") && (
                    job.progress === null ? (
                      <p className={styles.indeterminate}>{job.status === "queued" ? "開始を待っています" : "処理しています"}</p>
                    ) : (
                      <div className={styles.jobProgress}>
                        <progress max={100} value={job.progress} />
                        <span>{Math.round(job.progress)}%</span>
                      </div>
                    )
                  )}
                  <small>
                    試行 {job.attempts}回
                  </small>
                  {job.status === "failed" && job.error_message && (
                    <>
                      <p className={styles.jobFailure}>{jobFailureSummary(job)}</p>
                      <details className={styles.jobErrorDetails}>
                        <summary>エラー詳細</summary>
                        <p>{job.error_message}</p>
                      </details>
                    </>
                  )}
                  {job.status === "failed" && (
                    <button
                      disabled={retryingJobId === job.id}
                      type="button"
                      onClick={() => void retryJob(job.id)}
                    >
                      {retryingJobId === job.id ? "再試行中" : "再試行"}
                    </button>
                  )}
                </article>
              ))}
            </div>
            {historyJobs.length > 0 && (
              <details className={styles.jobHistory}>
                <summary className={styles.jobHistoryToggle}>
                  <span>過去の実行履歴</span>
                  <em>{historyJobs.length}件</em>
                </summary>
                <div className={styles.jobHistoryList}>
                  {historyJobs.map((job) => (
                    <article key={job.id} className={styles.jobHistoryItem} data-status={job.status}>
                      <div>
                        <strong>{jobLabel(job)}</strong>
                        <span data-status={job.status}>{jobStatusLabel(job)}</span>
                      </div>
                      <small>試行 {job.attempts}回</small>
                      {job.error_message && (
                        <details className={styles.jobHistoryError}>
                          <summary>エラー詳細</summary>
                          <p>{job.error_message}</p>
                        </details>
                      )}
                    </article>
                  ))}
                </div>
              </details>
            )}
            </>
          )}
        </div>
      </details>
    </section>
  );
}
