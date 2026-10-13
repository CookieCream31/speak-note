import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AISettingsManager } from "./ai-settings-manager";

vi.mock("@/app/actions", () => ({
  createAIProviderAction: vi.fn(),
}));

describe("AISettingsManager", () => {
  it("renders Soniox-only realtime settings and independent whole transcription without exposing keys", () => {
    const html = renderToStaticMarkup(
      <AISettingsManager
        initialProviders={[]}
        initialProfiles={[]}
        initialUsage={[]}
        initialTemplates={[]}
        initialTranscriptionSettings={{
          provider: "azure_speech",
          azure_region: "japaneast",
          azure_language: "ja-JP",
          has_api_key: true,
          api_key_masked: "****-key",
          soniox_model: "stt-rt-v5",
          has_soniox_api_key: true,
          soniox_api_key_masked: "****-soniox",
          updated_at: "2026-09-15T00:00:00Z",
        }}
      />,
    );

    expect(html).toContain("リアルタイム文字起こし");
    expect(html).toContain("文字起こしはSonioxを使用します");
    expect(html).not.toContain('name="transcription_provider"');
    // Templates are edited on their own page; AI settings only link to it.
    expect(html).toContain('href="/settings/templates"');
    expect(html).not.toContain('name="azure_region"');
    const realtimeForm = html.slice(html.indexOf('id="stt"'), html.indexOf('id="async-stt"'));
    expect(realtimeForm).not.toContain('name="api_key"');
    expect(html).not.toContain('name="azure_language"');
    expect(html).not.toContain('name="soniox_language"');
    expect(html).toContain("文字起こし設定");
    expect(html).toContain('type="password"');
    expect(html).toContain('placeholder="****-soniox"');
    expect(html).not.toContain('placeholder="****-key"');
    expect(html).not.toContain("azure-speech-secret-key");
    expect(html).toContain("接続テスト");
    expect(html).toContain('name="soniox_api_key"');
    expect(html).toContain("アップロード・録音終了後の文字起こし");
    expect(html).toContain('name="async_transcription_provider" checked="" value="whisperx"');
    expect(html).toContain('name="async_transcription_provider" value="soniox"');
  });
});
