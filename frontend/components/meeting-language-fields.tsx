"use client";

import { useEffect, useId, useState } from "react";
import styles from "./meeting-language-fields.module.css";

export interface MeetingLanguageSelection { hints: string[] | null; strict: boolean; }
interface LanguageOptions {
  languages: string[]; supports_auto: boolean; supports_multiple: boolean;
  supports_strict: boolean; providers: string[];
}
const names = new Intl.DisplayNames(["ja"], { type: "language" });
export function MeetingLanguageFields({ value, onChange, includeRealtime, disabled = false }: {
  value: MeetingLanguageSelection; onChange: (value: MeetingLanguageSelection) => void;
  includeRealtime: boolean; disabled?: boolean;
}) {
  const id = useId();
  const [options, setOptions] = useState<LanguageOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [additional, setAdditional] = useState("");
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      setLoading(true); setError("");
      try {
        const response = await fetch(`/api/v1/transcription/language-options?include_realtime=${includeRealtime}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error();
        const result = await response.json() as LanguageOptions;
        if (!Array.isArray(result.languages) || result.languages.some((code) => typeof code !== "string" || !/^[a-z]{2,3}$/.test(code))
          || !Array.isArray(result.providers) || [result.supports_auto, result.supports_multiple, result.supports_strict].some((flag) => typeof flag !== "boolean")) throw new Error();
        if (active) setOptions(result);
      } catch {
        if (active) { setOptions(null); setError("対応言語を取得できませんでした。再取得してください。"); }
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [includeRealtime, revision]);
  const hints = value.hints;
  const choice = hints == null ? "legacy" : hints.length === 0 ? "auto" : hints.length === 1 && ["ja", "en"].includes(hints[0]) && !custom ? hints[0] : "custom";
  function changeHints(next: string[]) { onChange({ hints: next, strict: next.length > 0 && value.strict }); }
  const unavailable = options && hints !== null && (
    (!hints.length && !options.supports_auto) || (hints.length > 1 && !options.supports_multiple)
    || hints.some((code) => !options.languages.includes(code)) || (value.strict && !options.supports_strict)
  );
  return <fieldset className={styles.fields} aria-busy={loading}>
    <legend>会議で話す言語</legend>
    <label className={styles.language}><span>文字起こし言語</span><select aria-label="文字起こし言語" value={choice} disabled={disabled || loading || !options} onChange={(event) => {
      const next = event.target.value;
      setCustom(next === "custom");
      if (next === "auto") changeHints([]);
      else if (next !== "custom") changeHints([next]);
      else if (!hints?.length) changeHints(["ja"]);
    }}>
      {hints == null && <option value="legacy">従来の設定を維持</option>}
      <option value="ja">日本語</option><option value="en">英語</option>
      <option value="auto" disabled={!options?.supports_auto}>自動判定</option>
      <option value="custom">その他{options?.supports_multiple ? "・複数の言語" : "の言語"}</option>
    </select></label>
    {choice === "custom" && <div className={styles.custom}>
      <div className={styles.selected}>{hints?.map((code) => <button key={code} type="button" disabled={disabled || loading || !options || hints.length === 1} aria-label={`${names.of(code) ?? code}を外す`} onClick={() => changeHints(hints.filter((item) => item !== code))}>{names.of(code) ?? code} {hints.length > 1 && "×"}</button>)}</div>
      <label className={styles.language}><span>{options?.supports_multiple ? "言語を追加" : "言語を変更"}</span><select aria-label="追加する言語" value={additional} disabled={disabled || loading || !options} onChange={(event) => {
        const code = event.target.value;
        setAdditional("");
        if (code) changeHints(options?.supports_multiple ? [...(hints ?? []), code] : [code]);
      }}><option value="">言語を選択</option>{options?.languages.filter((code) => !hints?.includes(code)).map((code) => <option key={code} value={code}>{names.of(code) ?? code} ({code})</option>)}</select></label>
    </div>}
    <p id={`${id}-hint`}>選択した言語を認識のヒントに使います。Sonioxでは他の言語も認識できます。自動判定ではヒントを送信しません。</p>
    <label className={styles.toggle}>
      <span><strong>選択した言語に限定する</strong><small>Strict language hints · Soniox用。完全な保証ではありません。通常はOFFを推奨します。</small></span>
      <input type="checkbox" role="switch" aria-label="選択した言語に限定する" aria-describedby={`${id}-hint`} checked={value.strict} disabled={disabled || loading || !options || (!options.supports_strict && !value.strict) || !hints?.length} onChange={(event) => onChange({ ...value, strict: event.target.checked })} />
    </label>
    {value.strict && (hints?.length ?? 0) > 1 && <p>Strictは1つの言語で最も安定します。複数言語では認識が不安定になる場合があります。</p>}
    {options && !options.supports_multiple && <p>現在のエンジンでは言語を1つ選択してください。自動判定・複数言語は、使用する文字起こしエンジンがすべてSonioxのときに利用できます。StrictはSonioxの処理だけに適用します。</p>}
    {unavailable && <p role="alert">選択中の言語設定は現在のエンジンで使用できません。言語設定を選び直してください。</p>}
    {loading && <p role="status">対応言語を確認中…</p>}
    {error && <div className={styles.error}><p role="alert">{error}</p><button type="button" disabled={disabled} onClick={() => setRevision((previous) => previous + 1)}>再取得</button></div>}
  </fieldset>;
}
