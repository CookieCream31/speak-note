import { ApiError, type AIProfile, type AIProvider } from "./api";

export interface AssistSource { id: string; name: string; content: string; start_ms?: number; }
export interface AssistConfiguration {
  profile_name: string; provider_name: string; provider_type: string;
  base_url: string | null; model: string; temperature: number;
  automatic?: { enabled: boolean; target_speaker: string | null; revision: string };
}
export interface AssistSession {
  id: string; capture_id: string; enabled: boolean; profile_id: string | null;
  configuration: AssistConfiguration; knowledge_snapshot: { sources: AssistSource[] };
}
export interface LiveAnswer {
  id: string; session_id: string; sequence: number; question: string;
  status: "queued" | "processing" | "checking" | "completed" | "failed" | "superseded";
  short_answer: string | null; detailed_answer: string | null;
  insufficient_information: boolean; source_ids: string[]; error_message: string | null;
  input_snapshot: { sources: AssistSource[]; configuration: AssistConfiguration };
  created_at: string;
}
export interface AssistFeed {
  capture_id: string | null;
  segments: Array<{ id: string; text: string; start_ms: number; speaker: string }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    ...init, headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null;
    throw new ApiError(typeof body?.detail === "string" ? body.detail : "回答支援の操作に失敗しました", response.status);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

const base = (meetingId: string) => `/meetings/${meetingId}/answer-assist`;
export const answerAssistApi = {
  profiles: () => request<AIProfile[]>("/ai/profiles"),
  providers: () => request<AIProvider[]>("/ai/providers"),
  session: (id: string) => request<AssistSession | null>(base(id) + "/session"),
  start: (id: string, profileId: string) => request<AssistSession>(base(id) + "/session", {
    method: "POST", body: JSON.stringify({ profile_id: profileId, consent: true }),
  }),
  stop: (id: string, sessionId: string) => request<void>(base(id) + `/session/${sessionId}`, { method: "DELETE" }),
  automatic: (id: string, sessionId: string, enabled: boolean, targetSpeaker: string) =>
    request<AssistSession>(base(id) + `/session/${sessionId}/automatic`, {
      method: "PATCH", body: JSON.stringify({ enabled, target_speaker: targetSpeaker || null }),
    }),
  feed: (id: string) => request<AssistFeed>(base(id) + "/feed"),
  answers: (id: string) => request<LiveAnswer[]>(base(id) + "/answers"),
  generate: (id: string, sessionId: string, question: string, brief = false) =>
    request<LiveAnswer>(base(id) + "/answers", {
      method: "POST", body: JSON.stringify({
        session_id: sessionId, request_id: crypto.randomUUID(),
        question, brevity: brief ? "brief" : "standard",
      }),
    }),
};

/** Legacy text helper. Automatic assistance uses the backend AI monitor, not this rule. */
export function isLikelyQuestion(text: string): boolean {
  return /[?？]|(?:です|ます|でしょう|できます)か[。\s]*$|教えて(?:ください)?|お聞かせ|どう(?:思|考)|なぜ|何故/.test(text.trim());
}
