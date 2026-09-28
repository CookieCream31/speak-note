import type {
  AnalysisItem,
  AnalysisItemKind,
  AnalysisStatus,
  AnalysisVersion,
  AnalysisVersionSummary,
  MeetingSourceType,
  MeetingTemplateSnapshot,
  RealtimeAnalysis,
} from "@/lib/api";

export const REALTIME_ANALYSIS_HISTORY_ID = "realtime";

const attentionTypeLabels = {
  unresolved: "未解決",
  missing_information: "情報不足",
  possible_contradiction: "矛盾の可能性",
  risk: "リスク",
} as const;

function historyStatus(analysis: RealtimeAnalysis): AnalysisStatus {
  if (analysis.status === "failed") return "failed";
  if (analysis.status === "queued" || analysis.status === "processing") return "processing";
  return "completed";
}

function evidenceRange(
  evidenceIds: string[],
  evidence: Map<string, RealtimeAnalysis["evidence"][number]>,
): { startMs: number | null; endMs: number | null } {
  const matching = [...new Set(evidenceIds)].flatMap((id) => {
    const item = evidence.get(id);
    return item ? [item] : [];
  });
  if (matching.length === 0) return { startMs: null, endMs: null };
  return {
    startMs: Math.min(...matching.map((item) => item.start_ms)),
    endMs: Math.max(...matching.map((item) => item.end_ms)),
  };
}

function analysisItem(
  analysis: RealtimeAnalysis,
  evidence: Map<string, RealtimeAnalysis["evidence"][number]>,
  kind: AnalysisItemKind,
  content: string,
  evidenceIds: string[],
  sequence: number,
  fields: Pick<AnalysisItem, "assignee" | "deadline"> = {
    assignee: null,
    deadline: null,
  },
): AnalysisItem {
  const range = evidenceRange(evidenceIds, evidence);
  return {
    id: `realtime-${kind}-${sequence}`,
    kind,
    state: "generated",
    content,
    assignee: fields.assignee,
    deadline: fields.deadline,
    start_ms: range.startMs,
    end_ms: range.endMs,
    sequence,
    evidence: [],
    created_at: analysis.updated_at,
    updated_at: analysis.updated_at,
  };
}

export function realtimeAnalysisToHistoryVersion(
  meetingId: string,
  analysis: RealtimeAnalysis,
  templateSnapshot: MeetingTemplateSnapshot | null = null,
): AnalysisVersion | null {
  const snapshot = analysis.snapshot;
  if (!snapshot) return null;

  const evidence = new Map(analysis.evidence.map((item) => [item.evidence_id, item]));
  const items: AnalysisItem[] = [];
  let sequence = 0;
  items.push({
    ...analysisItem(
      analysis,
      evidence,
      "summary",
      snapshot.summary.content,
      [],
      sequence++,
    ),
    start_ms: null,
    end_ms: null,
  });
  for (const item of snapshot.decisions) {
    items.push(analysisItem(
      analysis,
      evidence,
      "decision",
      item.status === "candidate" ? `【候補】${item.content}` : item.content,
      item.evidence_segment_ids,
      sequence++,
    ));
  }
  for (const item of snapshot.action_items) {
    items.push(analysisItem(
      analysis,
      evidence,
      "action_item",
      item.status === "done" ? `【完了】${item.content}` : item.content,
      item.evidence_segment_ids,
      sequence++,
      { assignee: item.assignee, deadline: item.deadline },
    ));
  }
  for (const item of snapshot.attention_items) {
    const details = [
      `【${attentionTypeLabels[item.type]}】${item.title}`,
      `分かっていること\n${item.known_information}`,
      item.information_needed
        ? `不足している情報\n${item.information_needed}`
        : null,
      `確認理由\n${item.reason}`,
    ].filter((value): value is string => value !== null);
    items.push(analysisItem(
      analysis,
      evidence,
      "open_question",
      details.join("\n\n"),
      item.evidence_segment_ids,
      sequence++,
    ));
  }
  for (const item of snapshot.key_facts) {
    items.push(analysisItem(
      analysis,
      evidence,
      "important_point",
      `${item.label}\n${item.value}`,
      item.evidence_segment_ids,
      sequence++,
    ));
  }

  return {
    id: REALTIME_ANALYSIS_HISTORY_ID,
    meeting_id: meetingId,
    transcript_version_id: "",
    provider_id: null,
    profile_id: null,
    job_id: null,
    version: 0,
    model: analysis.model ?? "モデル不明",
    temperature: 0,
    prompt_version: "realtime-history-v1",
    status: historyStatus(analysis),
    error_message: analysis.error_message,
    created_at: analysis.updated_at,
    completed_at: analysis.completed_at,
    template_snapshot: templateSnapshot,
    template_values: (snapshot.template_values ?? []).map((value) => ({
      ...value,
      evidence_segment_ids: value.evidence_segment_ids.flatMap((evidenceId) => {
        const matched = evidence.get(evidenceId);
        return matched ? [matched.segment_id] : [];
      }),
    })),
    items,
  };
}

export function isCompletedLiveMeetingNotes(
  sourceType: MeetingSourceType,
  transcriptKind: "live" | "final" | null,
  versions: AnalysisVersionSummary[],
  captureStatus?: "recording" | "finalizing" | "completed" | "failed" | null,
): boolean {
  return (
    (sourceType === "live" || sourceType === "audio_recording")
    && (captureStatus === "completed" || (
      captureStatus == null
      && transcriptKind === "final"
      && versions.some((version) => version.status === "completed")
    ))
  );
}
