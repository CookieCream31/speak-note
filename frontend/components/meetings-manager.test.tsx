import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AIProfile, Meeting } from "@/lib/api";

import { MeetingsManager } from "./meetings-manager";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/app/actions", () => ({
  bulkManageMeetingsAction: vi.fn(),
  createMeetingTagAction: vi.fn(),
  deleteMeetingAction: vi.fn(),
  deleteMeetingTagAction: vi.fn(),
  updateMeetingFavoriteAction: vi.fn(),
  updateMeetingTitleAction: vi.fn(),
}));

const aiProfiles: AIProfile[] = [
  {
    id: "00000000-0000-4000-8000-000000000020",
    name: "Gemini要約",
    provider_id: "00000000-0000-4000-8000-000000000021",
    model: "gemini-2.5-flash",
    temperature: 0.2,
    is_default: true,
    created_at: "2026-09-05T00:00:00Z",
    updated_at: "2026-09-05T00:00:00Z",
  },
];

const meetings: Meeting[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    title: "お気に入り会議",
    source_type: "audio_upload",
    status: "completed",
    created_at: "2026-09-05T00:00:00Z",
    updated_at: "2026-09-05T00:00:00Z",
    started_at: null,
    duration_ms: 60_000,
    active_transcript_version_id: null,
    active_analysis_version_id: null,
    ai_profile_id: null,
    project_id: null,
    ai_disabled: false,
    is_favorite: true,
    min_speakers: null,
    max_speakers: null,
    summary_format: "standard",
    meeting_context: null,
    template_id: null,
    template_snapshot: null,
    tags: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        name: "採用",
        created_at: "2026-09-05T00:00:00Z",
        updated_at: "2026-09-05T00:00:00Z",
      },
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    title: "通常会議",
    source_type: "video_upload",
    status: "created",
    created_at: "2026-09-04T00:00:00Z",
    updated_at: "2026-09-04T00:00:00Z",
    started_at: null,
    duration_ms: null,
    active_transcript_version_id: null,
    active_analysis_version_id: null,
    ai_profile_id: null,
    project_id: null,
    ai_disabled: false,
    is_favorite: false,
    min_speakers: null,
    max_speakers: null,
    summary_format: "standard",
    meeting_context: null,
    template_id: null,
    template_snapshot: null,
    tags: [],
  },
];

describe("MeetingsManager", () => {
  it("renders favorite filtering and bulk management controls", () => {
    const html = renderToStaticMarkup(
      <MeetingsManager
        meetings={meetings}
        tags={meetings[0].tags}
        aiProfiles={aiProfiles}
        templates={[]}
        initialCreateOpen
      />,
    );

    expect(html).toContain("お気に入り");
    expect(html).toContain('aria-label="表示中の会議をすべて選択"');
    expect(html).toContain('aria-label="お気に入り会議を選択"');
    expect(html).toContain('aria-label="お気に入り会議のお気に入りを解除"');
    expect(html).toContain('aria-label="通常会議をお気に入りに追加"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain('aria-label="タグで絞り込み"');
    expect(html).toContain("# 採用");
    expect(html.match(/data-record-menu="true"/g)).toHaveLength(2);
    expect(html).toContain("タグ管理");
    expect(html).toContain('name="min_speakers"');
    expect(html).toContain('name="max_speakers"');
    expect(html).toContain("空欄なら自動判定");
    expect(html).toContain("音声・動画をアップロード");
    expect(html).toContain("マイク音声を録音");
    expect(html).toContain("画面共有");
    expect(html).not.toContain('value="shared_audio"');
    expect(html.match(/name="source_type"/g)).toHaveLength(3);
    expect(html).toContain('value="audio_recording"');
    expect(html).toContain('id="new-meeting-media"');
    expect(html).toContain('type="file"');
    expect(html).toContain("作成してアップロード");
    expect(html).toContain('name="summary_format"');
    expect(html).toContain('name="auto_analyze"');
    expect(html).toContain("文字起こし後にAI要約を自動作成する");
    expect(html).toContain('name="ai_profile"');
    expect(html).toContain("Gemini要約");
    expect(html).toContain("gemini-2.5-flash");
    expect(html).toContain('name="meeting_context"');
    expect(html).not.toContain('value="audio_upload"');
    expect(html).not.toContain('value="video_upload"');
  });
});
