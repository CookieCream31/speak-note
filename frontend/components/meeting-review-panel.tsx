"use client";

import { Ellipsis, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type {
  AnalysisItem,
  AnalysisItemKind,
  AnalysisVersion,
  AnalysisVersionSummary,
} from "@/lib/api";
import { REALTIME_ANALYSIS_HISTORY_ID } from "@/lib/realtime-analysis-history";

import { SummaryRegenerationButton, type SummaryRegenerationProps } from "./final-transcript-button";
import { ManualAIImport } from "./manual-ai-import";
import { TemplateAnalysisCards, type TemplateDisplayValue } from "./template-analysis-cards";
import styles from "./meeting-review-panel.module.css";

interface EvidenceSegment {
  id: string;
  startMs: number;
  text: string;
  speakerName: string;
}

interface MeetingReviewPanelProps {
  meetingId: string;
  analysis: AnalysisVersion | null;
  versions: AnalysisVersionSummary[];
  realtimeHistory: AnalysisVersion | null;
  /** Omit when the page shows the regeneration button elsewhere (the meeting header). */
  regeneration?: SummaryRegenerationProps;
  regenerationKey?: string;
  evidenceSegments: EvidenceSegment[];
  playerAvailable: boolean;
  finalTranscriptAvailable?: boolean;
}

const sectionLabels: Partial<Record<AnalysisItemKind, string>> = {
  summary: "要約",
  decision: "決定事項",
  action_item: "Action Item",
  open_question: "確認ポイント",
  important_point: "重要情報",
  chapter: "チャプター",
  suggested_question: "質問候補",
};

const sectionOrder = Object.keys(sectionLabels) as AnalysisItemKind[];
const overviewKinds = new Set<AnalysisItemKind>([
  "summary",
  "decision",
  "action_item",
  "open_question",
  "important_point",
]);

const stateLabels = {
  generated: "AI生成",
  confirmed: "確認済み",
  edited: "編集済み",
};

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function player(): HTMLMediaElement | null {
  const element = document.querySelector("[data-meeting-media]");
  return element instanceof HTMLMediaElement ? element : null;
}

function openTranscript(): void {
  window.dispatchEvent(new Event("speak-note:open-transcript"));
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let message = `処理に失敗しました (${response.status})`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Keep status-based message.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export function MeetingReviewPanel({
  meetingId,
  analysis: initialAnalysis,
  versions,
  realtimeHistory,
  regeneration,
  regenerationKey,
  evidenceSegments,
  playerAvailable,
  finalTranscriptAvailable = true,
}: MeetingReviewPanelProps) {
  const router = useRouter();
  const [analysis, setAnalysis] = useState(initialAnalysis);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const highlightRanges = useRef<Array<[number, number]>>([]);
  const highlightIndex = useRef(0);
  const readOnly = analysis?.id === REALTIME_ANALYSIS_HISTORY_ID;

  const evidenceById = new Map(evidenceSegments.map((segment) => [segment.id, segment]));
  const highlights = analysis?.items.filter((item) => item.kind === "highlight") ?? [];
  const displayedKinds = sectionOrder.filter(
    (kind) => overviewKinds.has(kind) || analysis?.items.some((item) => item.kind === kind),
  );

  useEffect(() => {
    const media = player();
    if (!media) return;
    const continueHighlights = () => {
      const range = highlightRanges.current[highlightIndex.current];
      if (!range || media.currentTime * 1000 < range[1]) return;
      highlightIndex.current += 1;
      const next = highlightRanges.current[highlightIndex.current];
      if (!next) {
        highlightRanges.current = [];
        media.pause();
        setMessage("重要箇所の再生が完了しました");
        return;
      }
      media.currentTime = next[0] / 1000;
      void media.play();
    };
    media.addEventListener("timeupdate", continueHighlights);
    return () => media.removeEventListener("timeupdate", continueHighlights);
  }, []);

  function seek(milliseconds: number) {
    const media = player();
    if (!media) return;
    openTranscript();
    media.currentTime = milliseconds / 1000;
    void media.play();
  }

  function playHighlights() {
    const media = player();
    const ranges = highlights
      .filter((item) => item.start_ms !== null && item.end_ms !== null)
      .map((item) => [item.start_ms as number, item.end_ms as number] as [number, number])
      .filter(([start, end]) => end > start)
      .sort((left, right) => left[0] - right[0]);
    if (!media || ranges.length === 0) return;
    openTranscript();
    highlightRanges.current = ranges;
    highlightIndex.current = 0;
    media.currentTime = ranges[0][0] / 1000;
    void media.play();
    setMessage("重要箇所だけを連続再生しています");
  }

  function playFull() {
    const media = player();
    if (!media) return;
    openTranscript();
    highlightRanges.current = [];
    void media.play();
    setMessage("全編再生へ戻しました");
  }

  async function saveItem(item: AnalysisItem, fields: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const updated = await api<AnalysisItem>(
        `/meetings/${meetingId}/analyses/${analysis?.id}/items/${item.id}`,
        { method: "PATCH", body: JSON.stringify(fields) },
      );
      setAnalysis((current) => current
        ? {
            ...current,
            items: current.items.map((value) => value.id === updated.id ? updated : value),
          }
        : current);
      setEditingItemId(null);
      setMessage(fields.state === "confirmed" ? "確認済みにしました" : "修正を保存しました");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "項目を保存できませんでした");
    } finally {
      setBusy(false);
    }
  }

  function renderItem(item: AnalysisItem) {
    const editing = !readOnly && editingItemId === item.id;
    return (
      <article className={styles.analysisItem} key={item.id}>
        {editing ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void saveItem(item, {
              content: String(data.get("content") ?? "").trim(),
              ...(item.kind === "action_item" ? {
                assignee: String(data.get("assignee") ?? "").trim() || null,
                deadline: String(data.get("deadline") ?? "") || null,
              } : {}),
            });
          }}>
            <textarea name="content" defaultValue={item.content} rows={item.kind === "summary" ? 7 : 4} autoFocus />
            {item.kind === "action_item" && (
              <div className={styles.actionFields}>
                <input name="assignee" defaultValue={item.assignee ?? ""} placeholder="担当者不明" aria-label="担当" />
                <input name="deadline" type="date" defaultValue={item.deadline ?? ""} aria-label="期限" />
              </div>
            )}
            <div className={styles.editActions}>
              <button type="submit" disabled={busy}>保存</button>
              <button type="button" onClick={() => setEditingItemId(null)}>取消</button>
            </div>
          </form>
        ) : (
          <p className={styles.itemContent}>{item.content}</p>
        )}
        <div className={styles.itemMeta}>
          <span className={styles.stateBadge} data-state={item.state}>{stateLabels[item.state]}</span>
          {item.kind === "action_item" && !editing && (
            <>
              <span className={styles.metaField}>担当 <strong>{item.assignee ?? "担当者不明"}</strong></span>
              {item.deadline && <span className={styles.metaField}>期限 <strong>{item.deadline}</strong></span>}
            </>
          )}
          {item.start_ms !== null && (
            <button className={styles.timeChip} type="button" onClick={() => seek(item.start_ms as number)}>
              <Play size={12} aria-hidden="true" /> {formatTimestamp(item.start_ms)}
              {item.end_ms !== null && item.end_ms > item.start_ms
                ? `〜${formatTimestamp(item.end_ms)}`
                : ""}
            </button>
          )}
          {!readOnly && !editing && (
            <span className={styles.itemActions}>
              <button type="button" onClick={() => setEditingItemId(item.id)}>編集</button>
              {item.state !== "confirmed" && (
                <button type="button" disabled={busy} onClick={() => void saveItem(item, { state: "confirmed" })}>
                  確認済みにする
                </button>
              )}
            </span>
          )}
        </div>
        {item.evidence.length > 0 && (
          <details className={styles.evidence}>
            <summary>根拠となる発言 {item.evidence.length}件</summary>
            <div>
              {item.evidence.map(({ segment_id: segmentId }) => {
                const segment = evidenceById.get(segmentId);
                return segment ? (
                  <button key={segmentId} type="button" onClick={() => seek(segment.startMs)}>
                    <time>{formatTimestamp(segment.startMs)}</time>
                    <strong>{segment.speakerName}</strong>
                    <span>{segment.text}</span>
                  </button>
                ) : null;
              })}
            </div>
          </details>
        )}
      </article>
    );
  }

  const templateCoreRows = Object.fromEntries(([...sectionOrder, "highlight"] as AnalysisItemKind[]).map((kind) => {
    const items = analysis?.items.filter((item) => item.kind === kind).sort((a, b) => a.sequence - b.sequence) ?? [];
    if (kind === "summary" && items.length > 1) {
      const protectedSummary = items
        .filter((item) => item.state === "confirmed" || item.state === "edited")
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at)
          || right.sequence - left.sequence)[0];
      const latestGenerated = [...items].sort((left, right) => right.created_at.localeCompare(left.created_at)
        || right.sequence - left.sequence)[0];
      const selectedSummary = protectedSummary ?? latestGenerated;
      return [kind, selectedSummary ? [{ rowId: "summary:0", content: renderItem(selectedSummary) }] : []];
    }
    return [kind, items.map((item, index) => ({
      rowId: kind === "summary" ? "summary:0" : `${kind}:${index}`,
      content: renderItem(item),
    }))];
  }));

  return (
    <aside className={styles.panel} aria-label="AIノート">
      <header className={styles.heading}>
        <h2>AI議事録</h2>
        <div className={styles.headingControls}>
          {playerAvailable && highlights.length > 0 && (
            <div className={styles.reviewControls} role="group" aria-label="再生範囲">
              <button type="button" onClick={playFull}>全編</button>
              <button type="button" onClick={playHighlights}>重要箇所だけ再生</button>
            </div>
          )}
          {versions.length > 0 || realtimeHistory ? (
            <label className={styles.versionPicker}>
              <span className={styles.visuallyHidden}>履歴</span>
              <select
                aria-label="履歴"
                value={analysis?.id ?? ""}
                onChange={(event) => {
                  router.push(`/meetings/${meetingId}?analysis_id=${event.target.value}&transcript_kind=${event.target.value === REALTIME_ANALYSIS_HISTORY_ID ? "live" : "final"}`);
                }}
              >
                {!analysis && <option value="">Versionを選択</option>}
                {realtimeHistory && (
                  <option value={REALTIME_ANALYSIS_HISTORY_ID}>
                    リアルタイム解析 · {realtimeHistory.model} · {realtimeHistory.status}
                  </option>
                )}
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    確定版 v{version.version} · {version.model} · {version.status}
                  </option>
                ))}
              </select>
            </label>
          ) : analysis && (
            <span className={styles.versionLabel}>
              {readOnly ? "リアルタイム解析" : `確定版 v${analysis.version}`} · {analysis.model}
            </span>
          )}
          <details className={styles.moreMenu}>
            <summary aria-label="その他（外部AIで作成など）" title="その他">
              <Ellipsis size={16} aria-hidden="true" />
            </summary>
            <div>
              <ManualAIImport meetingId={meetingId} available={finalTranscriptAvailable && evidenceSegments.length > 0} />
            </div>
          </details>
        </div>
      </header>

      {(message || error) && (
        <p className={error ? styles.error : styles.message} role="status">
          {error || message}
        </p>
      )}

      {!finalTranscriptAvailable && <p className={styles.notice}>リアルタイム版は暫定結果です。要約の再生成で全体文字起こしを作成すると、編集や会議への質問も利用できます。</p>}

      {regeneration && <SummaryRegenerationButton key={regenerationKey} {...regeneration} />}

      {!analysis ? (
        <div className={styles.empty}>
          <strong>AI議事録はまだありません</strong>
          <span>文字起こし完了後に生成できます。</span>
        </div>
      ) : analysis.template_snapshot ? (
        <TemplateAnalysisCards
          cards={analysis.template_snapshot.definition[readOnly ? "realtime" : "final"]}
          values={(analysis.template_values ?? []) as TemplateDisplayValue[]}
          coreRows={templateCoreRows}
          onSelectEvidence={(segmentId) => {
            const segment = evidenceById.get(segmentId);
            if (segment) seek(segment.startMs);
          }}
        />
      ) : (
        <div className={styles.analysisGrid} data-analysis-overview aria-label="AI議事録の一覧">
          {displayedKinds.map((kind) => {
            const items = analysis.items.filter((item) => item.kind === kind);
            return (
              <section
                className={`${styles.analysisSection} ${kind === "summary" ? styles.summarySection : ""}`}
                data-analysis-kind={kind}
                key={kind}
              >
                <h3>
                  {sectionLabels[kind]}
                  {kind !== "summary" && <small>{items.length}</small>}
                </h3>
                {items.length === 0 ? (
                  <p className={styles.none}>まだありません</p>
                ) : (
                  <div className={styles.itemList}>
                    {items.map(renderItem)}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
}
