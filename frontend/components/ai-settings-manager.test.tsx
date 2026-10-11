import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AISettingsManager } from "./ai-settings-manager";

vi.mock("@/app/actions", () => ({
  createAIProviderAction: vi.fn(),
}));

describe("AISettingsManager", () => {
  it("renders realtime transcription provider settings without exposing the key", () => {
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
          updated_at: "2026-09-15T00:00:00Z",
        }}
      />,
    );

    expect(html).toContain("リアルタイム文字起こし");
    expect(html).toContain("リアルタイムSpeech-to-Text");
    // The saved Azure choice stays selected when Soniox is added.
    expect(html).toContain('<input type="radio" name="transcription_provider" value="whisperx"/>WhisperX');
    expect(html).toContain(
      '<input type="radio" name="transcription_provider" checked="" value="azure_speech"/>Azure AI Speech',
    );
    // Templates are edited on their own page; AI settings only link to it.
    expect(html).toContain('href="/settings/templates"');
    expect(html).toContain('name="azure_region"');
    expect(html).toContain('value="japaneast"');
    expect(html).toContain('name="azure_language"');
    expect(html).toContain('value="ja-JP"');
    expect(html).toContain('type="password"');
    expect(html).toContain('placeholder="****-key"');
    expect(html).not.toContain("azure-speech-secret-key");
    expect(html).toContain("接続テスト");
    expect(html).toContain('name="transcription_provider" value="soniox"');
    expect(html).toContain("非同期・確定版の文字起こし");
    expect(html).toContain("確定版のエンジン");
  });
});
