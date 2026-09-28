import { AISettingsManager } from "@/components/ai-settings-manager";
import type {
  AIProfile,
  AIProvider,
  AIUsageSetting,
  RealtimeTranscriptionSettings,
  MeetingTemplate,
} from "@/lib/api";

export const dynamic = "force-dynamic";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://backend:8001";

async function load<T>(path: string): Promise<T> {
  const response = await fetch(`${backendInternalUrl}/api/v1${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  return await response.json() as T;
}

export default async function AISettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const { message = "", error = "" } = await searchParams;
  const [providers, profiles, usage, transcriptionSettings, templates] = await Promise.all([
    load<AIProvider[]>("/ai/providers"),
    load<AIProfile[]>("/ai/profiles"),
    load<AIUsageSetting[]>("/ai/usage"),
    load<RealtimeTranscriptionSettings>("/transcription/realtime-settings"),
    load<MeetingTemplate[]>("/meeting-templates"),
  ]);
  return (
    <AISettingsManager
      initialProviders={providers}
      initialProfiles={profiles}
      initialUsage={usage}
      initialTranscriptionSettings={transcriptionSettings}
      initialTemplates={templates}
      initialMessage={message}
      initialError={error}
    />
  );
}

