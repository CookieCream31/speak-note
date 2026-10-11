"use client";

import { useState, type FormEvent } from "react";
import type { AsyncTranscriptionSettings } from "@/lib/api";
import styles from "./ai-settings-manager.module.css";

export function SonioxFields({ model, language, masked, disabled = false, hidden = false }: {
  model: string; language: string; masked?: string | null; disabled?: boolean; hidden?: boolean;
}) {
  return <div className={styles.speechFields} hidden={hidden}>
    <label><span>Sonioxモデル</span><input name="soniox_model" defaultValue={model} disabled={disabled} required maxLength={32} /></label>
    <label><span>言語ヒント</span><input name="soniox_language" defaultValue={language} placeholder="ja" pattern="[a-z]{2,3}" disabled={disabled} required /></label>
    <label><span>Soniox API Key</span><input name="soniox_api_key" type="password" autoComplete="new-password" placeholder={masked ?? "API Keyを入力"} disabled={disabled} /></label>
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
    const form = event.currentTarget;
    const data = new FormData(form);
    const key = String(data.get("soniox_api_key") ?? "").trim();
    if (provider === "soniox" && !key && !hasKey) { setError("Soniox API Keyを入力してください"); return; }
    void run(async () => {
      const saved = await saveTranscriptionRequest("async-settings", {
        provider,
        ...(provider === "soniox" ? {
          soniox_model: String(data.get("soniox_model")), soniox_language: String(data.get("soniox_language")),
          ...(key ? { soniox_api_key: key } : {}),
        } : {}),
      }) as AsyncTranscriptionSettings;
      setHasKey(saved.has_soniox_api_key);
      const input = form.elements.namedItem("soniox_api_key") as HTMLInputElement | null;
      if (input) input.value = "";
    }, "非同期・確定版の設定を保存しました");
  }
  return <form className={styles.speechForm} onSubmit={save} aria-label="非同期・確定版の文字起こし設定">
    <fieldset className={styles.segmented} disabled={busy}>
      <legend className={styles.visuallyHidden}>確定版のプロバイダー</legend>
      {(["whisperx", "soniox"] as const).map((value) => <label key={value} data-selected={provider === value}>
        <input type="radio" name="async_transcription_provider" value={value} checked={provider === value} onChange={() => setProvider(value)} />{value === "soniox" ? "Soniox" : "WhisperX"}
      </label>)}
    </fieldset>
    <SonioxFields model={initialSettings.soniox_model} language={initialSettings.soniox_language} masked={initialSettings.soniox_api_key_masked} disabled={provider !== "soniox" || busy} hidden={provider !== "soniox"} />
    <p className={styles.settingNote}>Sonioxを選ぶと、アップロード音声と停止後の保存音声をSonioxへ送信します。録音中の設定とは独立しています。保存済みの確定文字起こしがある要約再生成では、音声を再送しません。話者数の最小・最大指定はWhisperXでのみ使用します。</p>
    <div className={styles.speechActions}>
      <button type="button" className={styles.secondaryButton} disabled={busy || !hasKey || provider !== "soniox"} onClick={() => void run(() => saveTranscriptionRequest("async-settings/test"), "Sonioxへの接続に成功しました")}>接続テスト</button>
      <button type="submit" disabled={busy}>{busy ? "処理中…" : "設定を保存"}</button>
    </div>
    {message && <p role="status" className={styles.message}>{message}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </form>;
}
