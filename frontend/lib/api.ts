export type MeetingSourceType = "live" | "audio_recording" | "shared_audio" | "media_upload" | "video_upload" | "audio_upload";
export type MeetingSummaryFormat = "standard" | "concise" | "detailed" | "bullet";
export type TemplateFieldType = "short_text" | "long_text" | "number" | "date" | "boolean" | "single_select";
export type TemplateCoreKind = AnalysisItemKind;
export interface MeetingTemplateField {
  id: string; name: string; type: TemplateFieldType; options: string[]; required: boolean;
}
export interface MeetingTemplateCard {
  id: string; title: string; visible: boolean; show_when_empty: boolean;
  core_kind: TemplateCoreKind | null; fields: MeetingTemplateField[]; instructions?: string;
}
export interface MeetingTemplateDefinition { realtime: MeetingTemplateCard[]; final: MeetingTemplateCard[]; }
export interface MeetingTemplateSnapshot {
  template_id: string; revision: number; name: string; definition: MeetingTemplateDefinition;
}
export interface MeetingTemplate {
  id: string; name: string; definition: MeetingTemplateDefinition; revision: number;
  is_default: boolean; created_at: string; updated_at: string;
}
export interface AnalysisTemplateValue {
  card_id: string; row_id: string; field_id: string; field_type: TemplateFieldType;
  text_value: string | null; number_value: number | null; boolean_value: boolean | null;
  evidence_segment_ids: string[]; state?: "generated" | "edited" | "confirmed";
}

export type MeetingStatus =
  | "created"
  | "recording"
  | "uploading"
  | "preprocessing"
  | "queued"
  | "transcribing"
  | "analyzing"
  | "completed"
  | "failed";

export type RealtimeTranscriptionProvider = "whisperx" | "azure_speech";

export interface RealtimeTranscriptionSettings {
  provider: RealtimeTranscriptionProvider;
  azure_region: string | null;
  azure_language: string;
  has_api_key: boolean;
  api_key_masked: string | null;
  updated_at: string;
}

export type AIProviderType = "ollama" | "gemini";
export type AIUsage =
  | "realtime_analysis"
  | "final_minutes"
  | "suggested_questions"
  | "chapters";

export interface MeetingTag {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Meeting {
  id: string;
  project_id: string | null;
  title: string;
  source_type: MeetingSourceType;
  status: MeetingStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  duration_ms: number | null;
  active_transcript_version_id: string | null;
  active_analysis_version_id: string | null;
  ai_profile_id: string | null;
  ai_disabled: boolean;
  is_favorite: boolean;
  min_speakers: number | null;
  max_speakers: number | null;
  summary_format: MeetingSummaryFormat;
  meeting_context: string | null;
  template_id: string | null;
  template_snapshot: MeetingTemplateSnapshot | null;
  tags: MeetingTag[];
}

export interface MeetingList {
  items: Meeting[];
  total: number;
  limit: number;
  offset: number;
}

export interface Job {
  id: string;
  meeting_id: string;
  realtime_chunk_id: string | null;
  realtime_window_start_ms: number | null;
  realtime_window_end_ms: number | null;
  realtime_commit_start_ms: number | null;
  type:
    | "preprocess_media"
    | "transcribe"
    | "transcribe_live"
    | "analyze_realtime"
    | "analyze"
    | "ask_meeting"
    | "answer_live"
    | "generate_thumbnails";
  status: "queued" | "running" | "completed" | "failed";
  attempts: number;
  progress: number | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type MeetingQuestionStatus = "queued" | "processing" | "completed" | "failed";

export interface MeetingQuestion {
  id: string;
  meeting_id: string;
  transcript_version_id: string;
  provider_id: string | null;
  profile_id: string | null;
  job_id: string | null;
  question: string;
  answer: string | null;
  insufficient_information: boolean;
  model: string;
  status: MeetingQuestionStatus;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  evidence: Array<{ segment_id: string }>;
}

export interface Media {
  id: string;
  meeting_id: string;
  kind: "original_video" | "original_audio" | "playback_video" | "transcription_audio";
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  created_at: string;
}

export interface Speaker {
  id: string;
  meeting_id: string;
  internal_name: string;
  display_name: string | null;
  created_at: string;
}

export interface TranscriptWord {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  confidence: number | null;
  sequence: number;
  speaker_id: string | null;
}

export interface TranscriptSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  confidence: number | null;
  sequence: number;
  speaker: Speaker | null;
  provisional_speaker_label: string | null;
  words: TranscriptWord[];
}

export interface TranscriptVersion {
  id: string;
  meeting_id: string;
  version: number;
  kind: "live" | "final";
  status: "processing" | "completed" | "failed";
  language: string;
  model: string;
  diarization_enabled: boolean;
  created_at: string;
  segments: TranscriptSegment[];
}

export interface AIProvider {
  id: string;
  provider_type: AIProviderType;
  name: string;
  base_url: string | null;
  enabled: boolean;
  has_api_key: boolean;
  api_key_masked: string | null;
  created_at: string;
  updated_at: string;
}

export interface AIProfile {
  id: string;
  name: string;
  provider_id: string;
  model: string;
  temperature: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface AIUsageSetting {
  usage: AIUsage;
  profile_id: string | null;
  disabled: boolean;
  updated_at: string;
}

export type AnalysisStatus = "processing" | "completed" | "failed";
export type AnalysisItemKind =
  | "summary"
  | "decision"
  | "action_item"
  | "open_question"
  | "important_point"
  | "chapter"
  | "suggested_question"
  | "highlight";
export type AnalysisItemState = "generated" | "confirmed" | "edited";

export interface AnalysisEvidence {
  segment_id: string;
}

export interface AnalysisItem {
  id: string;
  kind: AnalysisItemKind;
  state: AnalysisItemState;
  content: string;
  assignee: string | null;
  deadline: string | null;
  start_ms: number | null;
  end_ms: number | null;
  sequence: number;
  evidence: AnalysisEvidence[];
  created_at: string;
  updated_at: string;
}

export interface AnalysisVersion {
  id: string;
  meeting_id: string;
  transcript_version_id: string;
  provider_id: string | null;
  profile_id: string | null;
  job_id: string | null;
  version: number;
  model: string;
  temperature: number;
  prompt_version: string;
  status: AnalysisStatus;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  items: AnalysisItem[];
  template_snapshot?: MeetingTemplateSnapshot | null;
  template_values?: AnalysisTemplateValue[];
}

export interface AnalysisVersionSummary {
  id: string;
  version: number;
  model: string;
  status: AnalysisStatus;
  created_at: string;
  completed_at: string | null;
}

export interface ManualAnalysisPrompt {
  transcript_version_id: string;
  prompt_version: string;
  filename: string;
  prompt: string;
}

export interface ManualChapterPreview {
  title: string;
  start_ms: number;
  end_ms: number;
}

export interface ManualAnalysisPreview {
  transcript_version_id: string;
  summary: string;
  item_counts: Record<string, number>;
  chapters: ManualChapterPreview[];
}

export interface Bookmark {
  id: string;
  meeting_id: string;
  timestamp_ms: number;
  title: string;
  note: string | null;
  created_at: string;
}

export interface TranscriptSearchResult {
  segment_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker_id: string | null;
  speaker_name: string;
}

export interface TimelineMarker {
  id: string;
  kind: string;
  timestamp_ms: number;
  end_ms: number | null;
  title: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = "リクエストに失敗しました。";
    try {
      const body = (await response.json()) as { detail?: string };
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      // Keep the generic message for non-JSON responses.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface SummaryRegenerationRequest {
  profile_id: string | null;
  template_id: string | null;
  template_revision: number | null;
  request_id: string;
}

export const analysisApi = {
  regenerate: (meetingId: string, options: SummaryRegenerationRequest) =>
    request<{ analysis: AnalysisVersionSummary | null; job_id: string }>(
      `/meetings/${meetingId}/analyses`,
      { method: "POST", body: JSON.stringify(options) },
    ),
};

export const meetingsApi = {
  list: (projectId?: string, offset = 0) => request<MeetingList>(`/meetings?limit=100&offset=${offset}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ""}`),
  create: (
    title: string,
    sourceType: MeetingSourceType,
    options?: {
      min_speakers?: number | null;
      max_speakers?: number | null;
      summary_format?: MeetingSummaryFormat;
      meeting_context?: string | null;
      template_id?: string | null;
      project_id?: string | null;
    },
  ) =>
    request<Meeting>("/meetings", {
      method: "POST",
      body: JSON.stringify({ title, source_type: sourceType, ...options }),
    }),
  update: (
    id: string,
    fields: {
      title?: string;
      status?: MeetingStatus;
      is_favorite?: boolean;
      min_speakers?: number | null;
      max_speakers?: number | null;
      summary_format?: MeetingSummaryFormat;
      meeting_context?: string | null;
      project_id?: string | null;
    },
  ) =>
    request<Meeting>(`/meetings/${id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    }),
  selectAI: (
    id: string,
    selection:
      | { mode: "default"; profile_id: null }
      | { mode: "profile"; profile_id: string }
      | { mode: "none"; profile_id: null },
  ) =>
    request<Meeting>(`/meetings/${id}/ai-profile`, {
      method: "PATCH",
      body: JSON.stringify(selection),
    }),
  delete: (id: string) => request<void>(`/meetings/${id}`, { method: "DELETE" }),
};

export const tagsApi = {
  list: () => request<MeetingTag[]>("/tags"),
  create: (name: string) =>
    request<MeetingTag>("/tags", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  delete: (id: string) => request<void>(`/tags/${id}`, { method: "DELETE" }),
};


export interface RealtimeAnalysisEvidence {
  evidence_id: string;
  segment_id: string;
  start_ms: number;
  end_ms: number;
  status: "draft" | "confirmed";
}

export interface RealtimeAnalysisSnapshot {
  input_revision: number;
  as_of_ms: number;
  summary: { content: string; evidence_segment_ids: string[] };
  decisions: Array<{
    content: string;
    status: "candidate" | "explicit";
    evidence_segment_ids: string[];
  }>;
  action_items: Array<{
    content: string;
    assignee: string | null;
    deadline: string | null;
    status: "open" | "done";
    evidence_segment_ids: string[];
  }>;
  attention_items: Array<{
    type: "unresolved" | "missing_information" | "possible_contradiction" | "risk";
    title: string;
    known_information: string;
    information_needed: string | null;
    reason: string;
    evidence_segment_ids: string[];
  }>;
  key_facts: Array<{
    label: string;
    value: string;
    evidence_segment_ids: string[];
  }>;
  template_values?: AnalysisTemplateValue[];
}

export interface RealtimeAnalysis {
  status: "queued" | "processing" | "completed" | "failed";
  input_revision: number;
  processed_revision: number;
  analyzed_through_ms: number;
  model: string | null;
  error_message: string | null;
  updated_at: string;
  completed_at: string | null;
  snapshot: RealtimeAnalysisSnapshot | null;
  evidence: RealtimeAnalysisEvidence[];
}

export interface LiveSession {
  id: string;
  status: "recording" | "finalizing" | "completed" | "failed";
  has_system_audio: boolean;
  chunk_count: number;
  transcription_provider: RealtimeTranscriptionProvider;
  transcription_region: string | null;
  received_bytes: number;
  duration_ms: number;
  started_at: string;
  ended_at: string | null;
  transcript_status: "processing" | "completed" | "failed";
  segments: TranscriptSegment[];
}


export interface PersonalProfile { id: string; name: string; body: string; revision: number; }
export interface Project { id: string; name: string; notes: string; parent_id: string | null; profile_id: string | null; revision: number; }
export interface ProjectDocument { id: string; project_id: string; name: string; content: string; included: boolean; revision: number; }

export const knowledgeApi = {
  profiles: () => request<PersonalProfile[]>("/knowledge/profiles"),
  saveProfile: (id: string | null, fields: { name: string; body: string }) => request<PersonalProfile>(
    id ? `/knowledge/profiles/${id}` : "/knowledge/profiles", { method: id ? "PUT" : "POST", body: JSON.stringify(fields) },
  ),
  projects: () => request<Project[]>("/knowledge/projects"),
  saveProject: (id: string | null, fields: { name: string; notes: string; parent_id: string | null; profile_id: string | null }) => request<Project>(
    id ? `/knowledge/projects/${id}` : "/knowledge/projects", { method: id ? "PUT" : "POST", body: JSON.stringify(fields) },
  ),
  documents: (projectId: string) => request<ProjectDocument[]>(`/knowledge/projects/${projectId}/documents`),
  saveDocument: (projectId: string, id: string | null, fields: { name: string; content: string; included: boolean }) => request<ProjectDocument>(
    id ? `/knowledge/projects/${projectId}/documents/${id}` : `/knowledge/projects/${projectId}/documents`,
    { method: id ? "PUT" : "POST", body: JSON.stringify(fields) },
  ),
};
