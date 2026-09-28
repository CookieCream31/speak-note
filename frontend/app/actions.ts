"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { AIProviderType } from "@/lib/api";

const validProviderTypes = new Set<AIProviderType>(["ollama", "gemini"]);
const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://backend:8001";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function send(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(`${backendInternalUrl}/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    let message = `Backend request failed with status ${response.status}`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Keep the status-based message for non-JSON responses.
    }
    throw new Error(message);
  }
}

function aiSettingsRedirect(kind: "message" | "error", message: string): never {
  redirect(`/settings/ai?${kind}=${encodeURIComponent(message)}`);
}

export async function createAIProviderAction(formData: FormData): Promise<void> {
  const providerType = String(formData.get("provider_type") ?? "") as AIProviderType;
  const name = String(formData.get("name") ?? "").trim();
  const baseUrl = String(formData.get("base_url") ?? "").trim();
  const apiKey = String(formData.get("api_key") ?? "").trim();

  if (!validProviderTypes.has(providerType) || !name) {
    aiSettingsRedirect("error", "Provider種別と設定名を入力してください");
  }
  if (providerType === "ollama" && !baseUrl) {
    aiSettingsRedirect("error", "Ollamaの接続先URLを入力してください");
  }
  if (providerType === "gemini" && !apiKey) {
    aiSettingsRedirect("error", "Gemini API Keyを入力してください");
  }

  try {
    await send("/ai/providers", {
      method: "POST",
      body: JSON.stringify({
        provider_type: providerType,
        name,
        base_url: providerType === "ollama" ? baseUrl : null,
        enabled: formData.get("enabled") === "on",
        api_key: providerType === "gemini" ? apiKey : null,
      }),
    });
  } catch (error) {
    aiSettingsRedirect(
      "error",
      error instanceof Error ? error.message : "Providerを追加できませんでした",
    );
  }

  revalidatePath("/settings/ai");
  aiSettingsRedirect("message", "Providerを追加しました");
}

export async function updateMeetingTitleAction(formData: FormData): Promise<void> {
  const meetingId = String(formData.get("meeting_id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!uuidPattern.test(meetingId) || !title || title.length > 200) return;

  await send(`/meetings/${meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
  revalidatePath("/");
  revalidatePath(`/meetings/${meetingId}`);
}

export async function deleteMeetingAction(formData: FormData): Promise<void> {
  const meetingId = String(formData.get("meeting_id") ?? "");
  if (!uuidPattern.test(meetingId)) return;

  await send(`/meetings/${meetingId}`, { method: "DELETE" });
  revalidatePath("/");
}

export async function updateMeetingFavoriteAction(
  meetingId: string,
  isFavorite: boolean,
): Promise<void> {
  if (!uuidPattern.test(meetingId)) throw new Error("会議IDが正しくありません");

  await send(`/meetings/${meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({ is_favorite: isFavorite }),
  });
  revalidatePath("/");
  revalidatePath(`/meetings/${meetingId}`);
}

export async function bulkManageMeetingsAction(
  action: "favorite" | "unfavorite" | "tag" | "untag" | "delete",
  meetingIds: string[],
  tagId?: string,
): Promise<void> {
  const uniqueMeetingIds = [...new Set(meetingIds)];
  if (
    uniqueMeetingIds.length === 0
    || uniqueMeetingIds.length > 100
    || uniqueMeetingIds.some((meetingId) => !uuidPattern.test(meetingId))
  ) {
    throw new Error("一括操作する会議を1〜100件選択してください");
  }
  if ((action === "tag" || action === "untag") && (!tagId || !uuidPattern.test(tagId))) {
    throw new Error("タグを選択してください");
  }

  await send("/meetings/bulk-actions", {
    method: "POST",
    body: JSON.stringify({ action, meeting_ids: uniqueMeetingIds, tag_id: tagId }),
  });
  revalidatePath("/");
  if (action !== "delete") {
    for (const meetingId of uniqueMeetingIds) revalidatePath(`/meetings/${meetingId}`);
  }
}

export async function createMeetingTagAction(name: string): Promise<void> {
  const normalizedName = name.trim().replace(/\s+/g, " ");
  if (!normalizedName || normalizedName.length > 50) {
    throw new Error("タグ名を1〜50文字で入力してください");
  }
  await send("/tags", {
    method: "POST",
    body: JSON.stringify({ name: normalizedName }),
  });
  revalidatePath("/");
}

export async function deleteMeetingTagAction(tagId: string): Promise<void> {
  if (!uuidPattern.test(tagId)) throw new Error("タグIDが正しくありません");
  await send(`/tags/${tagId}`, { method: "DELETE" });
  revalidatePath("/");
}

export async function updateSpeakerAction(formData: FormData): Promise<void> {
  const meetingId = String(formData.get("meeting_id") ?? "");
  const speakerId = String(formData.get("speaker_id") ?? "");
  const displayName = String(formData.get("display_name") ?? "").trim();
  if (!uuidPattern.test(meetingId) || !uuidPattern.test(speakerId) || displayName.length > 200) {
    return;
  }

  await send(`/meetings/${meetingId}/speakers/${speakerId}`, {
    method: "PATCH",
    body: JSON.stringify({ display_name: displayName || null }),
  });
  revalidatePath(`/meetings/${meetingId}`);
}

export async function updateSegmentAction(formData: FormData): Promise<void> {
  const meetingId = String(formData.get("meeting_id") ?? "");
  const segmentId = String(formData.get("segment_id") ?? "");
  const segmentText = String(formData.get("text") ?? "").trim();
  if (!uuidPattern.test(meetingId) || !uuidPattern.test(segmentId) || !segmentText) return;

  await send(`/meetings/${meetingId}/transcript/segments/${segmentId}`, {
    method: "PATCH",
    body: JSON.stringify({ text: segmentText }),
  });
  revalidatePath(`/meetings/${meetingId}`);
}
