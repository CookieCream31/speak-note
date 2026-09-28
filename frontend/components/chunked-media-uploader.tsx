"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import styles from "./chunked-media-uploader.module.css";

export interface UploadSession {
  id: string;
  size_bytes: number;
  chunk_size_bytes: number;
  chunk_count: number;
  received_chunks: number[];
  status: "uploading" | "completed";
}

interface ChunkedMediaUploaderProps {
  meetingId: string;
}

const RETRY_ATTEMPTS = 3;

async function responseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    if (payload.detail) return payload.detail;
  } catch {
    // Cloudflare and other proxies can return an HTML error page.
  }
  if (response.status === 413) {
    return "送信サイズが経路の上限を超えました。管理者にチャンクサイズの確認を依頼してください。";
  }
  return `アップロードに失敗しました（HTTP ${response.status}）`;
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await responseError(response));
  return (await response.json()) as T;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export interface UploadProgressUpdate {
  progress: number;
  statusText: string;
  session: UploadSession;
}

async function sendMediaChunk(
  meetingId: string,
  currentSession: UploadSession,
  selectedFile: File,
  chunkIndex: number,
): Promise<void> {
  const start = chunkIndex * currentSession.chunk_size_bytes;
  const end = Math.min(start + currentSession.chunk_size_bytes, selectedFile.size);
  const chunk = selectedFile.slice(start, end);
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      const formData = new FormData();
      formData.append("file", chunk, `chunk-${chunkIndex}.part`);
      await requestJson(
        `/api/v1/meetings/${meetingId}/uploads/${currentSession.id}/chunks/${chunkIndex}`,
        { method: "PUT", body: formData },
      );
      return;
    } catch (caught) {
      lastError = caught;
      if (attempt < RETRY_ATTEMPTS) await wait(attempt * 600);
    }
  }
  throw lastError;
}

export async function uploadMediaFile(
  meetingId: string,
  selectedFile: File,
  onProgress: (update: UploadProgressUpdate) => void,
  resumableSession: UploadSession | null = null,
): Promise<UploadSession> {
  let currentSession = resumableSession;
  if (!currentSession) {
    currentSession = await requestJson<UploadSession>(
      `/api/v1/meetings/${meetingId}/uploads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: selectedFile.name,
          mime_type: selectedFile.type || "application/octet-stream",
          size_bytes: selectedFile.size,
        }),
      },
    );
  } else {
    currentSession = await requestJson<UploadSession>(
      `/api/v1/meetings/${meetingId}/uploads/${currentSession.id}`,
      { method: "GET" },
    );
  }

  if (currentSession.status === "completed") {
    onProgress({ progress: 100, statusText: "アップロードが完了しました", session: currentSession });
    return currentSession;
  }

  const received = new Set(currentSession.received_chunks);
  for (let index = 0; index < currentSession.chunk_count; index += 1) {
    if (!received.has(index)) {
      onProgress({
        progress: Math.round((index / currentSession.chunk_count) * 98),
        statusText: `送信中 ${index + 1} / ${currentSession.chunk_count}`,
        session: currentSession,
      });
      await sendMediaChunk(meetingId, currentSession, selectedFile, index);
    }
    onProgress({
      progress: Math.round(((index + 1) / currentSession.chunk_count) * 98),
      statusText: `送信中 ${index + 1} / ${currentSession.chunk_count}`,
      session: currentSession,
    });
  }

  onProgress({ progress: 98, statusText: "ファイルを結合しています…", session: currentSession });
  await requestJson(
    `/api/v1/meetings/${meetingId}/uploads/${currentSession.id}/complete`,
    { method: "POST" },
  );
  const completedSession = { ...currentSession, status: "completed" as const };
  onProgress({ progress: 100, statusText: "アップロードが完了しました", session: completedSession });
  return completedSession;
}

export function ChunkedMediaUploader({ meetingId }: ChunkedMediaUploaderProps) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [session, setSession] = useState<UploadSession | null>(null);
  const [sessionFileKey, setSessionFileKey] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);

  useEffect(() => {
    if (!uploading) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [uploading]);

  const fileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : null;
  const accept = ".mp4,.mov,.webm,.m4a,.mp3,.wav,.flac,video/mp4,video/quicktime,video/webm,audio/mp4,audio/mpeg,audio/wav,audio/flac";
  const formats = "mp4 / mov / webm / m4a / mp3 / wav / flac";
  async function startUpload() {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);

    try {
      let currentSession = sessionFileKey === fileKey ? session : null;
      setProgress(0);
      setStatusText("アップロードを準備しています…");
      currentSession = await uploadMediaFile(
        meetingId,
        file,
        (update) => {
          setProgress(update.progress);
          setStatusText(update.statusText);
          setSession(update.session);
          setSessionFileKey(fileKey);
        },
        currentSession,
      );
      setSession(currentSession);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "アップロードに失敗しました");
      setStatusText(null);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={styles.uploader}>
      <label htmlFor="media-file">対応形式: {formats}</label>
      <input
        id="media-file"
        type="file"
        accept={accept}
        disabled={uploading}
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0] ?? null;
          setFile(selected);
          setSession(null);
          setSessionFileKey(null);
          setProgress(0);
          setStatusText(null);
          setError(null);
        }}
      />
      <p className={styles.hint}>
        ファイルから音声・動画を自動判定します。大きなファイルは分割して送信します。
      </p>
      {(uploading || progress > 0) && (
        <div className={styles.progress}>
          <div><span>{statusText}</span><strong>{progress}%</strong></div>
          <progress max={100} value={progress} aria-label="アップロード進捗" />
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button type="button" disabled={!file || uploading} onClick={startUpload}>
        {uploading
          ? "アップロード中…"
          : error && session
            ? "途中から再試行"
            : "アップロードして文字起こし →"}
      </button>
    </div>
  );
}
