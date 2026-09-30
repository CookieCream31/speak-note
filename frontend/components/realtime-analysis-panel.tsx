"use client";

import { ArrowDown } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { getLiveTranscriptStore, type StreamingTranscriptSegment } from "@/lib/live-transcript-store";

export type { StreamingTranscriptSegment } from "@/lib/live-transcript-store";
import type {
  LiveSession,
  MeetingTemplateSnapshot,
  RealtimeAnalysis,
  RealtimeAnalysisEvidence,
  TranscriptSegment,
} from "@/lib/api";

import { TemplateAnalysisCards, type TemplateDisplayValue } from "./template-analysis-cards";
import styles from "./realtime-analysis-panel.module.css";

interface RealtimeAnalysisPanelProps {
  meetingId: string;
  templateSnapshot?: MeetingTemplateSnapshot | null;
}

const EMPTY_PERSISTED_SEGMENTS: TranscriptSegment[] = [];

type RealtimeView = "summary" | "transcript";
type ViewStatus = "waiting" | "queued" | "processing" | "completed" | "failed";

export interface LiveTranscriptTurn {
  speakerKey: string;
  speakerName: string;
  segments: TranscriptSegment[];
  isFinal: boolean;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function mergeLiveTranscriptSegments(
  persisted: TranscriptSegment[],
  streaming: StreamingTranscriptSegment[],
): TranscriptSegment[] {
  const persistedById = new Map(persisted.map((segment) => [segment.id, segment]));
  const consumedPersistedIds = new Set<string>();
  const merged = streaming.map((segment) => {
    if (!segment.persistedId) return segment;
    const persistedSegment = persistedById.get(segment.persistedId);
    if (!persistedSegment) return segment;
    consumedPersistedIds.add(segment.persistedId);
    return {
      ...persistedSegment,
      id: segment.id,
      persistedId: segment.persistedId,
      isFinal: true,
    };
  });
  for (const segment of persisted) {
    if (!consumedPersistedIds.has(segment.id)) merged.push(segment);
  }
  return merged.sort((left, right) => (
    left.start_ms - right.start_ms || left.sequence - right.sequence
  ));
}

export function upsertStreamingTranscriptSegment(
  current: StreamingTranscriptSegment[],
  nextSegment: StreamingTranscriptSegment,
): StreamingTranscriptSegment[] {
  const existingIndex = current.findIndex((segment) => segment.id === nextSegment.id);
  if (existingIndex < 0) return [...current, nextSegment];
  const existing = current[existingIndex];
  // Finalization is monotonic. Ignore a late Azure partial event rather than
  // letting it replace an already finalized phrase in the live transcript.
  if (existing.isFinal && !nextSegment.isFinal) return current;
  const next = [...current];
  next[existingIndex] = {
    ...nextSegment,
    persistedId: existing.persistedId,
    isFinal: existing.isFinal || nextSegment.isFinal,
  };
  return next;
}

function speakerName(segment: TranscriptSegment): string {
  return (
    segment.speaker?.display_name
    ?? segment.speaker?.internal_name
    ?? segment.provisional_speaker_label
    ?? "話者不明"
  );
}

export function groupLiveTranscriptSegments(
  segments: TranscriptSegment[],
): LiveTranscriptTurn[] {
  const turns: LiveTranscriptTurn[] = [];
  for (const segment of segments) {
    const label = speakerName(segment);
    const isFinal = (segment as StreamingTranscriptSegment).isFinal ?? true;
    const knownSpeakerKey = isFinal
      ? segment.speaker?.id
        ?? (segment.provisional_speaker_label
          && segment.provisional_speaker_label !== "SPEAKER_UNKNOWN"
          ? "provisional:" + segment.provisional_speaker_label
          : null)
      : null;
    // Interim speaker IDs may change while Azure is recognizing a phrase. Keep
    // that phrase independent and only group it after the final event arrives.
    // Unknown final labels also stay separate because they do not prove identity.
    const speakerKey = !isFinal
      ? "interim:" + segment.id
      : knownSpeakerKey ?? "unknown:" + segment.id;
    const previous = turns.at(-1);
    if (previous?.speakerKey === speakerKey) {
      previous.segments.push(segment);
      continue;
    }
    turns.push({ speakerKey, speakerName: label, segments: [segment], isFinal });
  }
  return turns;
}

const statusLabels = {
  queued: "更新待ち",
  processing: "解析中",
  completed: "更新済み",
  failed: "更新エラー",
} as const;

const attentionLabels = {
  unresolved: "未解決",
  missing_information: "情報不足",
  possible_contradiction: "矛盾の可能性",
  risk: "リスク",
} as const;

export function EvidenceRange({
  evidenceIds,
  evidence,
  onSelect,
}: {
  evidenceIds: string[];
  evidence: Map<string, RealtimeAnalysisEvidence>;
  onSelect: (segmentId: string) => void;
}) {
  const values = [...new Set(evidenceIds)].flatMap((id) => {
    const item = evidence.get(id);
    return item ? [item] : [];
  });
  if (values.length === 0) return null;

  const first = values.reduce((earliest, item) => (
    item.start_ms < earliest.start_ms ? item : earliest
  ));
  const endMs = Math.max(...values.map((item) => item.end_ms));
  const includesDraft = values.some((item) => item.status === "draft");

  return (
    <div className={styles.evidence} aria-label="根拠となる発言">
      <button
        type="button"
        onClick={() => onSelect(first.segment_id)}
      >
        {formatTime(first.start_ms)}〜{formatTime(endMs)}
        {includesDraft ? " · 暫定" : ""}
      </button>
    </div>
  );
}

const LiveTranscriptTurnRow = memo(function LiveTranscriptTurnRow({
  turn,
}: {
  turn: LiveTranscriptTurn;
}) {
  const firstSegment = turn.segments[0];
  return (
    <article className={styles.transcriptTurn}>
      <div className={styles.transcriptMeta}>
        <time>{formatTime(firstSegment.start_ms)}</time>
        <strong>{turn.speakerName}</strong>
        <span>{turn.isFinal ? "暫定" : "認識中"}</span>
      </div>
      <p className={styles.transcriptText}>
        {turn.segments.map((segment, index) => (
          <span
            className={styles.transcriptSegmentAnchor}
            id={"live-segment-" + segment.id}
            key={segment.id}
          >
            {(segment as StreamingTranscriptSegment).persistedId && (
              <span id={"live-segment-" + (segment as StreamingTranscriptSegment).persistedId} />
            )}
            {index > 0 ? " " : ""}{segment.text}
          </span>
        ))}
      </p>
    </article>
  );
}, (previous, next) => {
  if (
    previous.turn.speakerKey !== next.turn.speakerKey
    || previous.turn.speakerName !== next.turn.speakerName
    || previous.turn.isFinal !== next.turn.isFinal
    || previous.turn.segments.length !== next.turn.segments.length
  ) return false;
  return previous.turn.segments.every((segment, index) => {
    const nextSegment = next.turn.segments[index];
    return segment.id === nextSegment.id
      && segment.start_ms === nextSegment.start_ms
      && segment.end_ms === nextSegment.end_ms
      && segment.text === nextSegment.text
      && ((segment as StreamingTranscriptSegment).persistedId
        === (nextSegment as StreamingTranscriptSegment).persistedId)
      && ((segment as StreamingTranscriptSegment).isFinal
        === (nextSegment as StreamingTranscriptSegment).isFinal);
  });
});

export function LiveTranscriptDocument({
  segments,
  turns: providedTurns,
  hideEmpty = false,
}: {
  segments: TranscriptSegment[];
  turns?: LiveTranscriptTurn[];
  hideEmpty?: boolean;
}) {
  if (segments.length === 0) {
    if (hideEmpty) return null;
    return (
      <div className={styles.empty}>
        <strong>発言を待っています</strong>
        <p>録画中の文字起こしが届くと、ここに発言順で表示します。</p>
      </div>
    );
  }

  const turns = providedTurns ?? groupLiveTranscriptSegments(segments);
  return (
    <div className={styles.transcriptDocument} aria-label="ライブ文字起こし">
      {turns.map((turn) => (
        <LiveTranscriptTurnRow key={turn.segments[0].id} turn={turn} />
      ))}
    </div>
  );
}

export function composeLiveTranscriptStream(
  segments: TranscriptSegment[],
  turns: LiveTranscriptTurn[],
  interim: StreamingTranscriptSegment | null,
) {
  return {
    segments: interim ? [...segments, interim] : segments,
    turns: interim
      ? [
          ...turns,
          {
            speakerKey: "interim:" + interim.id,
            speakerName: "認識中",
            segments: [interim],
            isFinal: false,
          },
        ]
      : turns,
  };
}

const LiveTranscriptPhrase = memo(function LiveTranscriptPhrase({
  segment,
  continuation,
}: {
  segment: StreamingTranscriptSegment;
  continuation: boolean;
}) {
  const final = segment.isFinal ?? true;
  return (
    <article
      className={styles.streamPhrase}
      data-result-id={segment.id}
      data-continuation={continuation}
      data-final={final}
    >
      <div className={styles.transcriptMeta} hidden={continuation}>
        <time>{formatTime(segment.start_ms)}</time>
        <strong>{final ? speakerName(segment) : "認識中"}</strong>
        <span>{final ? "暫定" : "話者は確定後に表示"}</span>
      </div>
      <p className={styles.transcriptText} id={"live-segment-" + segment.id}>
        {segment.persistedId && <span id={"live-segment-" + segment.persistedId} />}
        {segment.text}
      </p>
    </article>
  );
});

/** History and the active phrase are read from the same committed snapshot. */
export const LiveTranscriptStream = memo(function LiveTranscriptStream({
  meetingId,
  recording,
  persistedSegments,
}: {
  meetingId: string;
  recording: boolean;
  persistedSegments: TranscriptSegment[];
}) {
  const store = getLiveTranscriptStore(meetingId);
  const snapshot = useSyncExternalStore(
    store.subscribe, store.getSnapshot, store.getServerSnapshot,
  );
  const history = useMemo(
    () => mergeLiveTranscriptSegments(persistedSegments, snapshot.history),
    [persistedSegments, snapshot.history],
  );
  const turns = useMemo(() => groupLiveTranscriptSegments(history), [history]);
  const starts = useMemo(
    () => new Set(turns.map((turn) => turn.segments[0].id)),
    [turns],
  );
  const visible = snapshot.interim ? [...history, snapshot.interim] : history;
  if (!visible.length) return <LiveTranscriptDocument segments={[]} hideEmpty={recording} />;
  return (
    <div className={styles.transcriptDocument} aria-label="ライブ文字起こし">
      {visible.map((segment) => (
        <LiveTranscriptPhrase
          key={segment.id}
          segment={segment}
          continuation={(segment as StreamingTranscriptSegment).isFinal !== false && !starts.has(segment.id)}
        />
      ))}
    </div>
  );
});

/** Kept for isolated status rendering and backwards-compatible consumers. */
export const LiveInterimTranscript = memo(function LiveInterimTranscript({
  meetingId,
  recording,
}: {
  meetingId: string;
  recording: boolean;
}) {
  const store = getLiveTranscriptStore(meetingId);
  const interim = useSyncExternalStore(
    store.subscribeInterim, store.getInterim, store.getServerInterim,
  );
  if (!recording && !interim) return null;
  return (
    <div className={styles.interimDocument} aria-label="認識途中の文字起こし">
      <article className={styles.interimTurn}>
        <div className={styles.transcriptMeta}>
          {interim && <time>{formatTime(interim.start_ms)}</time>}
          <strong>認識中</strong>
          <span>話者は確定後に表示</span>
        </div>
        <p className={styles.interimText}>
          {interim?.text ?? "次の発話を待っています…"}
        </p>
      </article>
    </div>
  );
});

function LiveTranscriptViewport({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const element = viewport.current;
    const body = content.current;
    if (!element || !body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(body);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.transcriptViewportWrapper}>
      <div
        ref={viewport}
        className={styles.transcriptViewport}
        role="region"
        aria-label="文字起こし履歴"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          follow.current = atBottom;
          setFollowing(atBottom);
        }}
      >
        <div ref={content}>{children}</div>
      </div>
      {!following && (
        <button
          type="button"
          className={styles.followLatest}
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
          }}
        >
          最新の発話へ <ArrowDown size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function RealtimeAnalysisPanel({ meetingId, templateSnapshot }: RealtimeAnalysisPanelProps) {
  const [activeView, setActiveView] = useState<RealtimeView>("summary");
  const [analysis, setAnalysis] = useState<RealtimeAnalysis | null>(null);
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null);
  const transcriptStore = getLiveTranscriptStore(meetingId);
  const streamingSegments = useSyncExternalStore(
    transcriptStore.subscribeHistory, transcriptStore.getHistory, transcriptStore.getServerHistory,
  );
  const [error, setError] = useState("");
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const [analysisResponse, transcriptResponse] = await Promise.all([
        fetch(`/api/v1/meetings/${meetingId}/live/analysis`, { cache: "no-store" }),
        fetch(`/api/v1/meetings/${meetingId}/live`, { cache: "no-store" }),
      ]);

      if (!analysisResponse.ok && analysisResponse.status !== 404) {
        throw new Error(`Analysis HTTP ${analysisResponse.status}`);
      }
      if (!transcriptResponse.ok && transcriptResponse.status !== 404) {
        throw new Error(`Transcript HTTP ${transcriptResponse.status}`);
      }

      setAnalysis(
        analysisResponse.ok
          ? ((await analysisResponse.json()) as RealtimeAnalysis | null)
          : null,
      );
      const nextLiveSession = transcriptResponse.ok
        ? ((await transcriptResponse.json()) as LiveSession)
        : null;
      setLiveSession(nextLiveSession);
      setError("");
    } catch {
      setError("リアルタイム情報を更新できませんでした");
    } finally {
      refreshInFlight.current = false;
    }
  }, [meetingId]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const transcriptSegments = useMemo(
    () => mergeLiveTranscriptSegments(liveSession?.segments ?? [], streamingSegments),
    [liveSession?.segments, streamingSegments],
  );
  const transcriptTurns = useMemo(
    () => groupLiveTranscriptSegments(transcriptSegments),
    [transcriptSegments],
  );
  const transcriptTurnCount = transcriptTurns.length;

  const snapshot = analysis?.snapshot ?? null;
  const evidence = useMemo(
    () => new Map((analysis?.evidence ?? []).map((item) => [item.evidence_id, item])),
    [analysis?.evidence],
  );

  const selectEvidence = useCallback((segmentId: string) => {
    setActiveView("transcript");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document
          .getElementById(`live-segment-${segmentId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }, []);

  let viewStatus: { key: ViewStatus; label: string };
  if (activeView === "summary") {
    viewStatus = analysis
      ? { key: analysis.status, label: statusLabels[analysis.status] }
      : { key: "waiting", label: "解析待ち" };
  } else if (!liveSession) {
    viewStatus = { key: "waiting", label: "文字起こし待ち" };
  } else if (liveSession.status === "recording") {
    viewStatus = { key: "processing", label: "文字起こし中" };
  } else {
    const transcriptStatus = liveSession.transcript_status;
    viewStatus = {
      key: transcriptStatus,
      label: transcriptStatus === "processing"
        ? "文字起こし中"
        : transcriptStatus === "completed"
          ? "文字起こし済み"
          : "文字起こしエラー",
    };
  }

  return (
    <section className={styles.panel}>
      <header className={styles.panelHeader}>
        <div>
          <h2>リアルタイム解析</h2>
        </div>
        <div className={styles.status} data-status={viewStatus.key} aria-live="polite">
          <i aria-hidden="true" />
          {viewStatus.label}
        </div>
      </header>

      <nav className={styles.tabBar} role="tablist" aria-label="リアルタイム会議ノートの表示">
        <button
          className={styles.tabButton}
          type="button"
          role="tab"
          id="realtime-summary-tab"
          aria-controls="realtime-summary-panel"
          aria-selected={activeView === "summary"}
          onClick={() => setActiveView("summary")}
        >
          <span>AI要約</span>
        </button>
        <button
          className={styles.tabButton}
          type="button"
          role="tab"
          id="realtime-transcript-tab"
          aria-controls="realtime-transcript-panel"
          aria-selected={activeView === "transcript"}
          onClick={() => setActiveView("transcript")}
        >
          <span>文字起こし</span>
          <span className={styles.tabCount} aria-label={`${transcriptTurnCount}発言`}>
            {transcriptTurnCount}
          </span>
        </button>
      </nav>

      {error && <p className={styles.fetchError} role="alert">{error}</p>}

      <div
        className={styles.summaryPane}
        id="realtime-summary-panel"
        role="tabpanel"
        aria-labelledby="realtime-summary-tab"
        hidden={activeView !== "summary"}
      >
        {analysis?.status === "failed" && analysis.error_message && snapshot && (
          <p className={styles.error}>前回の結果を表示しています。{analysis.error_message}</p>
        )}
        {!snapshot ? (
          <div className={styles.empty}>
            <strong>{analysis?.status === "failed" ? "解析を更新できませんでした" : "発言を待っています"}</strong>
            <p>
              {analysis?.error_message
                ?? "文字起こしが追加されると、約30秒単位で会議の整理結果を更新します。"}
            </p>
          </div>
        ) : templateSnapshot ? (
          <TemplateAnalysisCards
            cards={templateSnapshot.definition.realtime}
            values={((snapshot.template_values ?? []).map((value) => ({
              ...value,
              evidence_segment_ids: value.evidence_segment_ids.flatMap((id) => {
                const matched = evidence.get(id);
                return matched ? [matched.segment_id] : [];
              }),
            }))) as TemplateDisplayValue[]}
            onSelectEvidence={selectEvidence}
            coreRows={{
              summary: [{
                rowId: "summary:0",
                content: <><p>{snapshot.summary.content}</p><EvidenceRange evidenceIds={snapshot.summary.evidence_segment_ids} evidence={evidence} onSelect={selectEvidence} /></>,
              }],
              decision: snapshot.decisions.map((item, index) => ({
                rowId: `decision:${index}`,
                content: <><p>{item.content}</p><span className={styles.badge}>{item.status === "explicit" ? "明示" : "候補"}</span><EvidenceRange evidenceIds={item.evidence_segment_ids} evidence={evidence} onSelect={selectEvidence} /></>,
              })),
              action_item: snapshot.action_items.map((item, index) => ({
                rowId: `action_item:${index}`,
                content: <><p>{item.content}</p><div className={styles.meta}><span>{item.assignee ?? "担当者未定"}</span><span>{item.deadline ?? "期限未定"}</span></div><EvidenceRange evidenceIds={item.evidence_segment_ids} evidence={evidence} onSelect={selectEvidence} /></>,
              })),
              open_question: snapshot.attention_items.map((item, index) => ({
                rowId: `open_question:${index}`,
                content: <><span className={styles.alertBadge}>{attentionLabels[item.type]}</span><h4>{item.title}</h4><dl><div><dt>分かっていること</dt><dd>{item.known_information}</dd></div>{item.information_needed && <div><dt>不足している情報</dt><dd>{item.information_needed}</dd></div>}<div><dt>確認理由</dt><dd>{item.reason}</dd></div></dl><EvidenceRange evidenceIds={item.evidence_segment_ids} evidence={evidence} onSelect={selectEvidence} /></>,
              })),
              important_point: snapshot.key_facts.map((item, index) => ({
                rowId: `important_point:${index}`,
                content: <><strong>{item.label}</strong><p>{item.value}</p><EvidenceRange evidenceIds={item.evidence_segment_ids} evidence={evidence} onSelect={selectEvidence} /></>,
              })),
            }}
          />
        ) : (
          <div className={styles.grid}>
            <article className={styles.summaryCard}>
              <h3>これまでの要約</h3>
              <p>{snapshot.summary.content}</p>
            </article>

            <article>
              <h3>決定事項 <small>{snapshot.decisions.length}</small></h3>
              {snapshot.decisions.length === 0 ? <p className={styles.none}>まだありません</p> : (
                <ul>{snapshot.decisions.map((item, index) => (
                  <li key={`${item.content}-${index}`}>
                    <p>{item.content}</p>
                    <span className={styles.badge}>{item.status === "explicit" ? "明示" : "候補"}</span>
                    <EvidenceRange evidenceIds={item.evidence_segment_ids} evidence={evidence} onSelect={selectEvidence} />
                  </li>
                ))}</ul>
              )}
            </article>

            <article>
              <h3>Action Item <small>{snapshot.action_items.length}</small></h3>
              {snapshot.action_items.length === 0 ? <p className={styles.none}>まだありません</p> : (
                <ul>{snapshot.action_items.map((item, index) => (
                  <li key={`${item.content}-${index}`}>
                    <p>{item.content}</p>
                    <div className={styles.meta}>
                      <span>{item.assignee ?? "担当者未定"}</span>
                      <span>{item.deadline ?? "期限未定"}</span>
                    </div>
                    <EvidenceRange evidenceIds={item.evidence_segment_ids} evidence={evidence} onSelect={selectEvidence} />
                  </li>
                ))}</ul>
              )}
            </article>

            <article>
              <h3>確認ポイント <small>{snapshot.attention_items.length}</small></h3>
              {snapshot.attention_items.length === 0 ? <p className={styles.none}>今のところありません</p> : (
                <ul>{snapshot.attention_items.map((item, index) => (
                  <li key={`${item.title}-${index}`}>
                    <span className={styles.alertBadge}>{attentionLabels[item.type]}</span>
                    <h4>{item.title}</h4>
                    <dl>
                      <div><dt>分かっていること</dt><dd>{item.known_information}</dd></div>
                      {item.information_needed && <div><dt>不足している情報</dt><dd>{item.information_needed}</dd></div>}
                      <div><dt>確認理由</dt><dd>{item.reason}</dd></div>
                    </dl>
                    <EvidenceRange evidenceIds={item.evidence_segment_ids} evidence={evidence} onSelect={selectEvidence} />
                  </li>
                ))}</ul>
              )}
            </article>

            <article>
              <h3>重要情報 <small>{snapshot.key_facts.length}</small></h3>
              {snapshot.key_facts.length === 0 ? <p className={styles.none}>まだありません</p> : (
                <ul>{snapshot.key_facts.map((item, index) => (
                  <li key={`${item.label}-${index}`}>
                    <strong>{item.label}</strong>
                    <p>{item.value}</p>
                    <EvidenceRange evidenceIds={item.evidence_segment_ids} evidence={evidence} onSelect={selectEvidence} />
                  </li>
                ))}</ul>
              )}
            </article>
          </div>
        )}
        {analysis && (
          <footer>
            発言 {analysis.processed_revision}/{analysis.input_revision} 更新
            {analysis.model ? ` · ${analysis.model}` : ""} · 確定版は録画終了後にボタンから作成できます
          </footer>
        )}
      </div>

      <div
        className={styles.transcriptPane}
        id="realtime-transcript-panel"
        role="tabpanel"
        aria-labelledby="realtime-transcript-tab"
        hidden={activeView !== "transcript"}
      >
        <div className={styles.transcriptToolbar}>
          <div>
            <strong>リアルタイム文字起こし</strong>
            <span>録画中の暫定文字起こしです。確定版は終了後にボタンから作成できます。</span>
          </div>
          <span>{transcriptTurnCount} 発言</span>
        </div>
        <LiveTranscriptViewport>
          <LiveTranscriptStream
            meetingId={meetingId}
            recording={liveSession?.status === "recording"}
            persistedSegments={liveSession?.segments ?? EMPTY_PERSISTED_SEGMENTS}
          />
        </LiveTranscriptViewport>
      </div>
    </section>
  );
}

