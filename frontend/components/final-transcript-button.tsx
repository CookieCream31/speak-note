"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { analysisApi, type AIProfile, type MeetingTemplate, type MeetingTemplateSnapshot } from "@/lib/api";
import styles from "./summary-regeneration.module.css";

function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface SummaryRegenerationProps {
  meetingId: string;
  ready: boolean;
  processing: boolean;
  profiles: AIProfile[];
  templates: MeetingTemplate[];
  currentProfileId: string | null;
  currentTemplate: MeetingTemplateSnapshot | null;
  aiDisabled?: boolean;
  hasFinal?: boolean;
}

export function SummaryRegenerationButton({
  meetingId, ready, processing, profiles, templates, currentProfileId, currentTemplate,
  aiDisabled = false, hasFinal = false,
}: SummaryRegenerationProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [profileId, setProfileId] = useState(currentProfileId ?? "");
  const [templateId, setTemplateId] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const sending = useRef(false);
  const requestId = useRef<string | null>(null);
  const unavailable = !ready || processing || busy || submitted;

  function open() {
    setError("");
    setProfileId(currentProfileId ?? "");
    setTemplateId("");
    requestId.current = newRequestId();
    dialog.current?.showModal();
  }

  function selectChanged() {
    requestId.current = newRequestId();
    setError("");
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || unavailable || (aiDisabled && !profileId)) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await analysisApi.regenerate(meetingId, {
        profile_id: profileId || null,
        template_id: templateId || null,
        template_revision: templates.find((template) => template.id === templateId)?.revision ?? null,
        request_id: requestId.current ?? newRequestId(),
      });
      setSubmitted(true);
      dialog.current?.close();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "要約を再生成できませんでした");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return <div className={styles.entry}>
    <button type="button" disabled={unavailable} onClick={open}>
      {processing || busy || submitted ? "要約を再生成中…" : "要約を再生成"}
    </button>
    {!ready && <span>録音の保存・動画変換・文字起こしの完了を待ってください。</span>}
    {(processing || submitted) && <p role="status">処理中も保存済みの議事録を閲覧できます。</p>}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={`regeneration-title-${meetingId}`}
      onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <form onSubmit={(event) => void start(event)}>
        <header><h2 id={`regeneration-title-${meetingId}`}>要約を再生成</h2><p>今回の生成に使う設定を選びます。</p></header>
        <label><span>AIプロファイル</span>
          <select aria-label="AIプロファイル" value={profileId} disabled={busy}
            onChange={(event) => { setProfileId(event.target.value); selectChanged(); }}>
            <option value="">{aiDisabled ? "AIプロファイルを選択" : "会議のAI設定を使用"}</option>
            {currentProfileId && !profiles.some((profile) => profile.id === currentProfileId)
              && <option value={currentProfileId}>会議で使用したプロファイル（利用不可）</option>}
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
          </select>
        </label>
        <label><span>議事録テンプレート</span>
          <select aria-label="議事録テンプレート" value={templateId} disabled={busy}
            onChange={(event) => { setTemplateId(event.target.value); selectChanged(); }}>
            <option value="">{currentTemplate ? `会議で使用した設定 · ${currentTemplate.name} · v${currentTemplate.revision}` : "会議で使用した設定（標準形式）"}</option>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name} · v{template.revision}</option>)}
          </select>
        </label>
        <p className={styles.hint}>テンプレートの「確定後」の構成と指示を使用します。会議やリアルタイム解析の設定は変更しません。</p>
        <p className={styles.hint}>{hasFinal ? "保存済みの全体文字起こしを使い、要約だけを生成します。" : "初回はWhisperXで全体文字起こしを保存してから生成します。次回から文字起こしを再利用します。"}</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>キャンセル</button>
          <button type="submit" disabled={unavailable || (aiDisabled && !profileId)}>{busy ? "送信中…" : "再生成を開始"}</button>
        </footer>
      </form>
    </dialog>
  </div>;
}
