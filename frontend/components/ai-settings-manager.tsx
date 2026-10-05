"use client";

import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";

import { createAIProviderAction } from "@/app/actions";

import type {
  MeetingTemplate,
  AIProfile,
  AIProvider,
  AIProviderType,
  AIUsage,
  AIUsageSetting,
  RealtimeTranscriptionProvider,
  RealtimeTranscriptionSettings,
} from "@/lib/api";

import { AIProfileList } from "./ai-profile-list";
import { AppSidebar } from "./app-sidebar";
import styles from "./ai-settings-manager.module.css";
import { ThemeSelector } from "./theme-selector";

interface AISettingsManagerProps {
  initialProviders: AIProvider[];
  initialProfiles: AIProfile[];
  initialUsage: AIUsageSetting[];
  initialTranscriptionSettings: RealtimeTranscriptionSettings;
  initialTemplates: MeetingTemplate[];
  initialMessage?: string;
  initialError?: string;
}

const sections = [
  { id: "providers", label: "接続先" },
  { id: "profiles", label: "AIプロファイル" },
  { id: "templates", label: "議事録テンプレート" },
  { id: "usage", label: "用途別の割り当て" },
  { id: "stt", label: "リアルタイム文字起こし" },
] as const;

const usageHints: Partial<Record<AIUsage, string>> = {
  suggested_questions: "現在の一括議事録生成では確定議事録と同じAIを使います",
  chapters: "現在の一括議事録生成では確定議事録と同じAIを使います",
};

const usageLabels: Record<AIUsage, string> = {
  realtime_analysis: "リアルタイム解析",
  final_minutes: "確定議事録",
  suggested_questions: "質問候補",
  chapters: "チャプター",
};

async function request(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    let message = `リクエストに失敗しました (${response.status})`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Keep the status-based message for non-JSON responses.
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return await response.json() as Record<string, unknown>;
}

function formString(data: FormData, name: string): string {
  return String(data.get(name) ?? "").trim();
}

export function AISettingsManager({
  initialProviders,
  initialProfiles,
  initialUsage,
  initialTranscriptionSettings,
  initialTemplates,
  initialMessage = "",
  initialError = "",
}: AISettingsManagerProps) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [providerType, setProviderType] = useState<AIProviderType>("ollama");
  const [transcriptionProvider, setTranscriptionProvider] =
    useState<RealtimeTranscriptionProvider>(initialTranscriptionSettings.provider);
  const [hasAzureApiKey, setHasAzureApiKey] =
    useState(initialTranscriptionSettings.has_api_key);
  const [message, setMessage] = useState<string>(initialMessage);
  const [error, setError] = useState<string>(initialError);
  const [busy, setBusy] = useState(false);
  const [providerFormOpen, setProviderFormOpen] = useState(initialProviders.length === 0);
  const defaultTemplate = initialTemplates.find((template) => template.is_default);

  async function run(action: () => Promise<void>, successMessage: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      if (successMessage) setMessage(successMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function reloadAfter(action: () => Promise<void>) {
    await run(async () => {
      await action();
      window.location.reload();
    }, "保存しました");
  }

  function createProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (providerType === "ollama" && !formString(data, "base_url")) {
      setError("Ollamaの接続先URLを入力してください");
      return;
    }
    if (providerType === "gemini" && !formString(data, "api_key")) {
      setError("Gemini API Keyを入力してください");
      return;
    }
    void reloadAfter(async () => {
      await request("/ai/providers", {
        method: "POST",
        body: JSON.stringify({
          provider_type: providerType,
          name: formString(data, "name"),
          base_url: providerType === "ollama" ? formString(data, "base_url") : null,
          enabled: data.get("enabled") === "on",
          api_key: providerType === "gemini" ? formString(data, "api_key") || null : null,
        }),
      });
    });
  }

  function updateProvider(event: FormEvent<HTMLFormElement>, provider: AIProvider) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const apiKey = formString(data, "api_key");
    void reloadAfter(async () => {
      await request(`/ai/providers/${provider.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: formString(data, "name"),
          base_url: provider.provider_type === "ollama" ? formString(data, "base_url") : null,
          enabled: data.get("enabled") === "on",
          ...(apiKey ? { api_key: apiKey } : {}),
        }),
      });
    });
  }

  function updateUsage(usage: AIUsage, value: string) {
    void reloadAfter(async () => {
      await request(`/ai/usage/${usage}`, {
        method: "PUT",
        body: JSON.stringify({
          disabled: value === "none",
          profile_id: value === "default" || value === "none" ? null : value,
        }),
      });
    });
  }
  function updateRealtimeTranscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const region = formString(data, "azure_region");
    const language = formString(data, "azure_language")
      || initialTranscriptionSettings.azure_language;
    const apiKey = formString(data, "api_key");
    if (transcriptionProvider === "azure_speech" && !region) {
      setError("Azure AI Speechのリージョンを入力してください");
      return;
    }
    if (
      transcriptionProvider === "azure_speech"
      && !apiKey
      && !hasAzureApiKey
    ) {
      setError("Azure AI SpeechのAPI Keyを入力してください");
      return;
    }
    void run(async () => {
      await request("/transcription/realtime-settings", {
        method: "PUT",
        body: JSON.stringify({
          provider: transcriptionProvider,
          azure_region: region || initialTranscriptionSettings.azure_region,
          azure_language: language,
          ...(apiKey ? { api_key: apiKey } : {}),
        }),
      });
      if (apiKey) setHasAzureApiKey(true);
    }, "リアルタイム文字起こしの設定を保存しました");
  }

  function testAzureSpeech() {
    void run(async () => {
      await request("/transcription/realtime-settings/test", { method: "POST" });
    }, "Azure AI Speechへの接続に成功しました");
  }
  return (
    <div className={styles.shell}>
      <AppSidebar current="settings" />
      <main className={styles.main}>
        <header className={styles.header}>
          <h1>AI設定</h1>
          <ThemeSelector />
        </header>

        <div className={styles.content}>
          <nav className={styles.toc} aria-label="AI設定の項目">
            {sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.label}</a>)}
          </nav>

          <div className={styles.sections}>
            {(message || error) && (
              <div className={error ? styles.error : styles.message} role="status">
                {error || message}
              </div>
            )}

            <section className={styles.section} id="providers">
              <div className={styles.sectionHeading}>
                <h2>接続先</h2>
                {!providerFormOpen && (
                  <button type="button" className={styles.secondaryButton} onClick={() => setProviderFormOpen(true)}>
                    <Plus size={14} aria-hidden="true" />接続先を追加
                  </button>
                )}
              </div>
              <p className={styles.sectionNote}>OllamaのURLやGeminiのAPI Keyを管理します。API Keyは暗号化して保存されます。</p>
              {providerFormOpen && (
                <form
                  action={createAIProviderAction}
                  className={styles.createForm}
                  onSubmit={createProvider}
                >
                  <select
                    aria-label="Provider種別"
                    name="provider_type"
                    value={providerType}
                    onChange={(event) => setProviderType(event.target.value as AIProviderType)}
                  >
                    <option value="ollama">Ollama</option>
                    <option value="gemini">Gemini</option>
                  </select>
                  <input name="name" placeholder="設定名" maxLength={200} required />
                  <input
                    className={styles.ollamaField}
                    name="base_url"
                    defaultValue="http://host.docker.internal:11434"
                    placeholder="Ollama接続先URL"
                  />
                  <input
                    className={styles.geminiField}
                    name="api_key"
                    type="password"
                    placeholder="Gemini API Key"
                  />
                  <label><input name="enabled" type="checkbox" defaultChecked /> 有効</label>
                  <div className={styles.formActions}>
                    {initialProviders.length > 0 && (
                      <button type="button" className={styles.secondaryButton} onClick={() => setProviderFormOpen(false)}>キャンセル</button>
                    )}
                    <button disabled={busy} type="submit">
                      {busy ? "追加中..." : "Providerを追加"}
                    </button>
                  </div>
                </form>
              )}

              <div className={styles.cards}>
                {initialProviders.map((provider) => (
                  <article key={provider.id} className={styles.card}>
                    <div className={styles.cardTitle}>
                      <span>{provider.provider_type === "ollama" ? "Ollama" : "Gemini"}</span>
                      <strong>{provider.name}</strong>
                      <small data-enabled={provider.enabled}>{provider.enabled ? "有効" : "無効"}</small>
                    </div>
                    <form onSubmit={(event) => updateProvider(event, provider)}>
                      <label><span>設定名</span><input name="name" defaultValue={provider.name} required /></label>
                      {provider.provider_type === "ollama" && (
                        <label><span>URL</span><input name="base_url" defaultValue={provider.base_url ?? ""} required /></label>
                      )}
                      {provider.provider_type === "gemini" && (
                        <label><span>API Key</span>
                          <input
                            name="api_key"
                            type="password"
                            placeholder={provider.api_key_masked ?? "API Keyを設定"}
                          />
                        </label>
                      )}
                      <div className={styles.cardFormRow}>
                        <label className={styles.inlineCheck}>
                          <input name="enabled" type="checkbox" defaultChecked={provider.enabled} /> 有効
                        </label>
                        <button disabled={busy} type="submit">保存</button>
                      </div>
                    </form>
                    <div className={styles.cardActions}>
                      <button
                        disabled={busy}
                        type="button"
                        onClick={() => void run(async () => {
                          await request(`/ai/providers/${provider.id}/test`, { method: "POST" });
                        }, `${provider.name}: 接続成功`)}
                      >接続テスト</button>
                      <button
                        disabled={busy}
                        type="button"
                        onClick={() => void run(async () => {
                          const result = await request(
                            `/ai/providers/${provider.id}/models`,
                            { method: "GET" },
                          );
                          const models = Array.isArray(result?.models)
                            ? result.models.join(", ")
                            : "なし";
                          setMessage(`利用可能モデル: ${models}`);
                        }, "")}
                      >モデル取得</button>
                      <button
                        className={styles.danger}
                        disabled={busy}
                        type="button"
                        onClick={() => void reloadAfter(async () => {
                          await request(`/ai/providers/${provider.id}`, { method: "DELETE" });
                        })}
                      >削除</button>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className={styles.section} id="profiles">
              <div className={styles.sectionHeading}>
                <h2>AIプロファイル</h2>
              </div>
              <p className={styles.sectionNote}>接続先・モデル・Temperatureの組み合わせです。</p>
              <AIProfileList
                profiles={profiles}
                providers={initialProviders}
                busy={busy}
                onBusyChange={setBusy}
                onChange={setProfiles}
                request={request}
              />
            </section>

            <section className={`${styles.section} ${styles.templateSummary}`} id="templates">
              <div>
                <h2>議事録テンプレート</h2>
                <span>
                  {initialTemplates.length}件
                  {defaultTemplate ? ` · 既定：${defaultTemplate.name}` : " · 既定なし"}
                  {" · 会議作成と要約の再生成で選択します"}
                </span>
              </div>
              <Link className={styles.secondaryButton} href="/settings/templates">
                テンプレートを編集<ChevronRight size={14} aria-hidden="true" />
              </Link>
            </section>

            <section className={styles.section} id="usage">
              <div className={styles.sectionHeading}>
                <h2>用途別の割り当て</h2>
              </div>
              <p className={styles.sectionNote}>未指定の用途はDefault Profileを使います。</p>
              <div className={styles.usageList}>
                {initialUsage.map((setting) => (
                  <label key={setting.usage}>
                    <span>
                      {usageLabels[setting.usage]}
                      {usageHints[setting.usage] && <small>{usageHints[setting.usage]}</small>}
                    </span>
                    <select
                      key={setting.profile_id && !profiles.some((profile) => profile.id === setting.profile_id) ? "removed" : setting.profile_id ?? "default"}
                      defaultValue={setting.disabled ? "none" : profiles.some((profile) => profile.id === setting.profile_id) ? setting.profile_id! : "default"}
                      disabled={busy}
                      onChange={(event) => updateUsage(setting.usage, event.target.value)}
                    >
                      <option value="default">Default Profile</option>
                      <option value="none">AIなし</option>
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>{profile.name}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </section>

            <section className={styles.section} id="stt">
              <div className={styles.sectionHeading}>
                <h2>リアルタイム文字起こし</h2>
              </div>
              <p className={styles.sectionNote}>録音・画面共有中のLive文字起こしに使います（リアルタイムSpeech-to-Text）。確定版はWhisperXで作成します。</p>
              <form className={styles.speechForm} onSubmit={updateRealtimeTranscription}>
                <fieldset className={styles.segmented}>
                  <legend className={styles.visuallyHidden}>プロバイダー</legend>
                  {([["whisperx", "WhisperX"], ["azure_speech", "Azure AI Speech"]] as const).map(([value, label]) => (
                    <label key={value} data-selected={transcriptionProvider === value}>
                      <input
                        type="radio"
                        name="transcription_provider"
                        value={value}
                        checked={transcriptionProvider === value}
                        onChange={() => setTranscriptionProvider(value)}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <div className={styles.speechFields}>
                  <label>
                    <span>Azureリージョン</span>
                    <input
                      name="azure_region"
                      defaultValue={initialTranscriptionSettings.azure_region ?? ""}
                      placeholder="例: japaneast"
                      disabled={transcriptionProvider !== "azure_speech"}
                    />
                  </label>
                  <label>
                    <span>認識言語</span>
                    <input
                      name="azure_language"
                      defaultValue={initialTranscriptionSettings.azure_language}
                      placeholder="ja-JP"
                      disabled={transcriptionProvider !== "azure_speech"}
                    />
                  </label>
                  <label>
                    <span>Azure API Key</span>
                    <input
                      name="api_key"
                      type="password"
                      autoComplete="new-password"
                      placeholder={initialTranscriptionSettings.api_key_masked ?? "API Keyを入力"}
                      disabled={transcriptionProvider !== "azure_speech"}
                    />
                  </label>
                </div>
                <div className={styles.speechActions}>
                  <button
                    className={styles.secondaryButton}
                    disabled={busy || !hasAzureApiKey}
                    type="button"
                    onClick={testAzureSpeech}
                  >接続テスト</button>
                  <button disabled={busy} type="submit">設定を保存</button>
                </div>
                <p className={styles.settingNote}>
                  Azure AI SpeechはLive文字起こしに使用します。リアルタイム話者分離はStandard (S0) が必要です。確定版はWhisperXで再処理し、話者分離を行います。
                </p>
              </form>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
