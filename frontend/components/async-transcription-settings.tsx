"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AsyncTranscriptionSettings } from "@/lib/api";
import styles from "./ai-settings-manager.module.css";

export function SonioxFields({ model, masked, purpose, hasSavedKey, onLoadingChange, disabled = false, hidden = false }: {
  model: string; masked?: string | null; purpose: "realtime" | "async";
  hasSavedKey: boolean; onLoadingChange: (loading: boolean) => void; disabled?: boolean; hidden?: boolean;
}) {
  const keyInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [hasDraftKey, setHasDraftKey] = useState(false);
  const [selectedModel, setSelectedModel] = useState(model);
  const [models, setModels] = useState<{ id: string; name: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => () => request.current?.abort(), []);

  async function loadModels() {
    if (disabled || request.current) return;
    const key = keyInput.current?.value.trim();
    if (!key && !hasSavedKey) { setError("Soniox API Keyを入力してください"); return; }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); onLoadingChange(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/v1/transcription/soniox-models", {
        method: "POST", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose, ...(key ? { soniox_api_key: key } : {}) }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { detail?: unknown };
        throw new Error(typeof failure.detail === "string" ? failure.detail : "Sonioxモデル一覧を取得できませんでした");
      }
      const result = await response.json() as { models?: { id: string; name: string }[] };
      const prefix = purpose === "realtime" ? "stt-rt-" : "stt-async-";
      if (!Array.isArray(result.models) || result.models.some((entry) => !entry || typeof entry.id !== "string" || !entry.id.startsWith(prefix) || typeof entry.name !== "string")) {
        throw new Error("Sonioxモデル一覧の形式が不正です");
      }
      if (!result.models.length) throw new Error("この用途で使用できるSonioxモデルがありません");
      if (controller.signal.aborted) return;
      setModels(result.models);
      if (!result.models.some((entry) => entry.id === selectedModel)) setSelectedModel("");
      setMessage(`${result.models.length}件のモデルを取得しました。選択後に設定を保存してください。`);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Sonioxモデル一覧を取得できませんでした");
    } finally {
      request.current = null;
      if (!controller.signal.aborted) { setLoading(false); onLoadingChange(false); }
    }
  }

  return <div className={styles.speechFields} hidden={hidden} aria-busy={loading}>
    <label><span>Soniox API Key</span><input ref={keyInput} name="soniox_api_key" type="password" autoComplete="new-password" placeholder={masked ?? (hasSavedKey ? "保存済み（変更する場合に入力）" : "API Keyを入力")} disabled={disabled || loading} onChange={(event) => { setHasDraftKey(Boolean(event.target.value.trim())); setModels(null); setMessage(""); setError(""); }} /></label>
    <label><span>Sonioxモデル</span><select name="soniox_model" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={disabled || loading} required>
      <option value="" disabled>モデルを選択</option>
      {models === null && selectedModel && <option value={selectedModel}>{selectedModel}（現在の選択）</option>}
      {models?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.id}</option>)}
    </select></label>
    <div className={styles.modelActions}>
      <button type="button" className={styles.secondaryButton} disabled={disabled || loading || (!hasDraftKey && !hasSavedKey)} onClick={() => void loadModels()}>{loading ? "取得中…" : "モデル一覧を取得"}</button>
      <span className={styles.settingNote}>入力したキー、またはこの用途の保存済みキーで取得します。取得だけでは設定を保存しません。</span>
    </div>
    <p className={`${styles.settingNote} ${styles.sonioxHelp}`}>必要な権限：Model listing → Access、{purpose === "realtime" ? "Speech-to-text, real-time → Access、Temporary API keys → Access" : "Speech-to-text, async → Write、Files → Write"}。Full accessはOFFで使用できます。<a href="https://soniox.com/docs/guides/api-key-permissions" target="_blank" rel="noreferrer">公式の権限説明</a></p>
    {message && <p role="status" className={`${styles.message} ${styles.sonioxHelp}`}>{message}</p>}
    {error && <p role="alert" className={`${styles.error} ${styles.sonioxHelp}`}>{error}</p>}
  </div>;
}

export async function saveTranscriptionRequest(path: string, body?: object) {
  const response = await fetch(`/api/v1/transcription/${path}`, {
    method: body ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { detail?: unknown };
    throw new Error(typeof error.detail === "string" ? error.detail : `処理に失敗しました (${response.status})`);
  }
  return await response.json();
}

export function AsyncTranscriptionSettingsForm({ initialSettings }: { initialSettings: AsyncTranscriptionSettings }) {
  const [provider, setProvider] = useState(initialSettings.provider);
  const [hasKey, setHasKey] = useState(initialSettings.has_soniox_api_key);
  const [busy, setBusy] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true); setMessage(""); setError("");
    try { await action(); setMessage(success); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "処理に失敗しました"); }
    finally { setBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || modelsLoading) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const key = String(data.get("soniox_api_key") ?? "").trim();
    if (provider === "soniox" && !key && !hasKey) { setError("Soniox API Keyを入力してください"); return; }
    void run(async () => {
      const saved = await saveTranscriptionRequest("async-settings", {
        provider,
        ...(provider === "soniox" ? {
          soniox_model: String(data.get("soniox_model")),
          ...(key ? { soniox_api_key: key } : {}),
        } : {}),
      }) as AsyncTranscriptionSettings;
      setHasKey(saved.has_soniox_api_key);
      const input = form.elements.namedItem("soniox_api_key") as HTMLInputElement | null;
      if (input) input.value = "";
    }, "非同期・確定版の設定を保存しました");
  }
  return <form className={styles.speechForm} onSubmit={save} aria-label="非同期・確定版の文字起こし設定">
    <fieldset className={styles.segmented} disabled={busy || modelsLoading}>
      <legend className={styles.visuallyHidden}>確定版のプロバイダー</legend>
      {(["whisperx", "soniox"] as const).map((value) => <label key={value} data-selected={provider === value}>
        <input type="radio" name="async_transcription_provider" value={value} checked={provider === value} onChange={() => setProvider(value)} />{value === "soniox" ? "Soniox" : "WhisperX"}
      </label>)}
    </fieldset>
    <SonioxFields model={initialSettings.soniox_model} masked={initialSettings.soniox_api_key_masked} purpose="async" hasSavedKey={hasKey} onLoadingChange={setModelsLoading} disabled={provider !== "soniox" || busy || modelsLoading} hidden={provider !== "soniox"} />
    <p className={styles.settingNote}>文字起こし言語は「新しい会議」または会議ページの「文字起こし設定」で選択します。</p>
    <p className={styles.settingNote}>Sonioxを選ぶと、アップロード音声と停止後の保存音声をSonioxへ送信します。録音中の設定とは独立しています。保存済みの確定文字起こしがある要約再生成では、音声を再送しません。話者数の最小・最大指定はWhisperXでのみ使用します。</p>
    <div className={styles.speechActions}>
      <button type="button" className={styles.secondaryButton} disabled={busy || modelsLoading || !hasKey || provider !== "soniox"} onClick={() => void run(() => saveTranscriptionRequest("async-settings/test"), "Sonioxへの接続に成功しました")}>接続テスト</button>
      <button type="submit" disabled={busy || modelsLoading}>{busy ? "処理中…" : "設定を保存"}</button>
    </div>
    {message && <p role="status" className={styles.message}>{message}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </form>;
}
