import { MeetingsManager } from "@/components/meetings-manager";
import type { AIProfile, MeetingList, MeetingTag, MeetingTemplate, Project } from "@/lib/api";
import { loadAllMeetings, MEETING_PAGE_SIZE } from "@/lib/meeting-list";

export const dynamic = "force-dynamic";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://backend:8001";

async function loadMeetingPage(offset: number): Promise<MeetingList> {
  const response = await fetch(
    `${backendInternalUrl}/api/v1/meetings?limit=${MEETING_PAGE_SIZE}&offset=${offset}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`Backend returned status ${response.status}`);
  }
  return (await response.json()) as MeetingList;
}

async function loadTags(): Promise<MeetingTag[]> {
  const response = await fetch(`${backendInternalUrl}/api/v1/tags`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Backend returned status ${response.status}`);
  return (await response.json()) as MeetingTag[];
}

async function loadMeetingTemplates(): Promise<MeetingTemplate[]> {
  const response = await fetch(backendInternalUrl + "/api/v1/meeting-templates", { cache: "no-store" });
  if (!response.ok) throw new Error("Backend returned status " + response.status);
  return (await response.json()) as MeetingTemplate[];
}

async function loadAIProfiles(): Promise<AIProfile[]> {
  const response = await fetch(`${backendInternalUrl}/api/v1/ai/profiles`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Backend returned status ${response.status}`);
  return (await response.json()) as AIProfile[];
}

export default async function Home({ searchParams }: { searchParams: Promise<{ create?: string; project_id?: string }> }) {
  const params = await searchParams;
  let meetings: MeetingList["items"] = [];
  let tags: MeetingTag[] = [];
  let aiProfiles: AIProfile[] = [];
  let templates: MeetingTemplate[] = [];
  let projects: Project[] = [];
  let loadError: string | undefined;
  let tagLoadError: string | undefined;
  let aiProfileLoadError: string | undefined;
  let templateLoadError: string | undefined;

  try {
    meetings = await loadAllMeetings(loadMeetingPage);
  } catch {
    loadError = "会議一覧を取得できませんでした。Backendの状態を確認してください。";
  }

  try {
    tags = await loadTags();
  } catch {
    tagLoadError = "タグを取得できませんでした。Backendの状態を確認してください。";
  }

  try {
    templates = await loadMeetingTemplates();
  } catch {
    templateLoadError = "議事録テンプレートを取得できませんでした。";
  }

  try {
    const response = await fetch(`${backendInternalUrl}/api/v1/knowledge/projects`, { cache: "no-store" });
    if (response.ok) projects = await response.json() as Project[];
  } catch { /* Project selection stays unavailable while the backend is offline. */ }

  try {
    aiProfiles = await loadAIProfiles();
  } catch {
    aiProfileLoadError = "AIプロファイルを取得できませんでした。AI設定を確認してください。";
  }

  return (
    <MeetingsManager
      meetings={meetings}
      tags={tags}
      aiProfiles={aiProfiles}
      templates={templates}
      projects={projects}
      initialCreateOpen={params.create === "1"}
      initialProjectId={projects.some((project) => project.id === params.project_id) ? params.project_id : null}
      templateLoadError={templateLoadError}
      loadError={loadError}
      tagLoadError={tagLoadError}
      aiProfileLoadError={aiProfileLoadError}
    />
  );
}
