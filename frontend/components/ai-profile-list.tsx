"use client";

import { type FormEvent, useRef, useState } from "react";
import type { AIProfile, AIProvider } from "@/lib/api";
import styles from "./ai-profile-list.module.css";

interface Props {
  profiles: AIProfile[];
  providers: AIProvider[];
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onChange: (profiles: AIProfile[]) => void;
  request: (path: string, init: RequestInit) => Promise<Record<string, unknown> | null>;
}

export function AIProfileList({ profiles, providers, busy, onBusyChange, onChange, request }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);

  function openEditor(id: string | null) {
    if (dirty && !window.confirm("保存していない変更を破棄しますか？")) return;
    setEditing(id);
    setDirty(false);
    setError("");
    setMessage("");
  }

  async function run(action: () => Promise<void>) {
    if (busy || pending.current) return;
    pending.current = true;
    onBusyChange(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存に失敗しました");
    } finally {
      pending.current = false;
      onBusyChange(false);
    }
  }

  function selectDefault(profile: AIProfile) {
    void run(async () => {
      await request(`/ai/profiles/${profile.id}`, {
        method: "PATCH", body: JSON.stringify({ is_default: true }),
      });
      onChange(profiles.map((item) => ({ ...item, is_default: item.id === profile.id })));
      setMessage(`「${profile.name}」をデフォルトに設定しました`);
    });
  }

  function save(event: FormEvent<HTMLFormElement>, profile?: AIProfile) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const model = String(data.get("model") ?? "").trim();
    if (!name || !model) {
      setError("プロファイル名とモデル名を入力してください");
      return;
    }
    void run(async () => {
      const result = await request(profile ? `/ai/profiles/${profile.id}` : "/ai/profiles", {
        method: profile ? "PATCH" : "POST",
        body: JSON.stringify({
          name, model, provider_id: data.get("provider_id"),
          temperature: Number(data.get("temperature")),
          // Editing never changes the default selected in the list.
          ...(!profile ? { is_default: profiles.length === 0 } : {}),
        }),
      });
      const saved = result as unknown as AIProfile;
      onChange(profile ? profiles.map((item) => item.id === profile.id ? saved : item) : [...profiles, saved]);
      setEditing(null);
      setDirty(false);
      setMessage(`「${name}」を保存しました`);
    });
  }

  function remove(profile: AIProfile) {
    if (!window.confirm(`「${profile.name}」を削除しますか？${profile.is_default ? "デフォルトが未設定になります。" : ""}`)) return;
    void run(async () => {
      await request(`/ai/profiles/${profile.id}`, { method: "DELETE" });
      onChange(profiles.filter((item) => item.id !== profile.id));
      setEditing(null);
      setDirty(false);
      setMessage(`「${profile.name}」を削除しました`);
    });
  }

  function editor(profile?: AIProfile) {
    return (
      <form key={profile?.id ?? "new"} id={`profile-editor-${profile?.id ?? "new"}`} className={styles.editor}
        aria-label={profile ? `${profile.name}の編集` : "プロファイルの追加"}
        onSubmit={(event) => save(event, profile)} onChange={() => setDirty(true)}>
        <h3>{profile ? "プロファイルを編集" : "新しいプロファイル"}</h3>
        <fieldset disabled={busy} className={styles.fields}>
          <legend className={styles.srOnly}>生成設定</legend>
          <label>プロファイル名
            <input name="name" defaultValue={profile?.name ?? ""} placeholder="例: 議事録用" maxLength={200} required />
          </label>
          <label>接続先
            <select name="provider_id" defaultValue={profile?.provider_id ?? providers[0]?.id} required>
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.enabled ? "" : "（無効）"}</option>)}
            </select>
          </label>
          <label>モデル名
            <input name="model" defaultValue={profile?.model ?? ""} placeholder="モデル名を入力" required />
          </label>
          <label>Temperature
            <input name="temperature" type="number" min="0" max="2" step="0.1" defaultValue={profile?.temperature ?? 0.2} required />
            <small>値を低くすると、出力のばらつきを抑えます。</small>
          </label>
        </fieldset>
        <div className={styles.editorActions}>
          {profile && <button className={styles.deleteButton} type="button" disabled={busy} onClick={() => remove(profile)}>削除</button>}
          <div>
            <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => openEditor(null)}>キャンセル</button>
            <button className={styles.primaryButton} type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <p id="profile-list-help">デフォルトを選択。プロファイルをクリックして編集できます。</p>
        <button className={styles.secondaryButton} type="button" disabled={busy || !providers.length} aria-expanded={editing === "new"} aria-controls="profile-editor-new" onClick={() => openEditor(editing === "new" ? null : "new")}>
          ＋ プロファイルを追加
        </button>
      </div>
      <div aria-live="polite" role="status">{message && <p className={styles.success}>{message}</p>}</div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {editing === "new" && editor()}
      {!profiles.length ? (
        <p className={styles.empty}>{providers.length ? "プロファイルはまだありません。追加してAIの生成設定を保存しましょう。" : "先に接続先を追加してください。"}</p>
      ) : (
        <>
          {!profiles.some((profile) => profile.is_default) && <p className={styles.notice}>デフォルトが未設定です。一覧から選択してください。</p>}
          <fieldset className={styles.list} aria-describedby="profile-list-help">
            <legend className={styles.srOnly}>デフォルトのAIプロファイル</legend>
            {profiles.map((profile) => {
              const provider = providers.find((item) => item.id === profile.provider_id);
              const expanded = editing === profile.id;
              return (
                <div key={profile.id} className={styles.item}>
                  <div className={styles.row} data-default={profile.is_default} data-expanded={expanded}>
                    <label className={styles.radioLabel}>
                      <input type="radio" name="default-ai-profile" value={profile.id} checked={profile.is_default} disabled={busy} onChange={() => selectDefault(profile)} />
                      <span className={styles.srOnly}>{profile.name}をデフォルトにする</span>
                    </label>
                    <button type="button" className={styles.rowButton} disabled={busy}
                      aria-label={`${profile.name}を編集`} aria-expanded={expanded} aria-controls={`profile-editor-${profile.id}`}
                      onClick={() => openEditor(expanded ? null : profile.id)}>
                      <span className={styles.profileInfo}>
                        <span className={styles.name}>{profile.name}{profile.is_default && <span className={styles.badge}>デフォルト</span>}</span>
                        <span className={styles.meta}>{provider?.name ?? "接続先なし"} · {profile.model}{provider && !provider.enabled ? " · 接続先が無効" : ""}</span>
                      </span>
                      <span className={styles.editHint}>編集</span>
                      <svg className={styles.chevron} data-expanded={expanded} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
                    </button>
                  </div>
                  {expanded && editor(profile)}
                </div>
              );
            })}
          </fieldset>
        </>
      )}
    </div>
  );
}
