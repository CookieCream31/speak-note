"use client";

import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import styles from "./meeting-language-fields.module.css";
import type { RealtimeTranslationConfig } from "@/lib/api";
import { MeetingTranslationFields } from "./meeting-translation-fields";

export interface MeetingLanguageSelection { hints: string[] | null; strict: boolean; translation?: RealtimeTranslationConfig | null; }
interface LanguageOptions {
  languages: string[]; supports_auto: boolean; supports_multiple: boolean;
  supports_strict: boolean; providers: string[];
  supports_translation?: boolean; translation_languages?: string[];
}
const names = new Intl.DisplayNames(["ja"], { type: "language" });
const englishNames = new Intl.DisplayNames(["en"], { type: "language" });
const providerNames: Record<string, string> = { whisperx: "WhisperX", azure_speech: "Azure AI Speech" };
export function MeetingLanguageFields({ value, onChange, includeRealtime, disabled = false, translationLocked = false }: {
  value: MeetingLanguageSelection; onChange: (value: MeetingLanguageSelection) => void;
  includeRealtime: boolean; disabled?: boolean;
  translationLocked?: boolean;
}) {
  const id = useId();
  const [capabilities, setCapabilities] = useState<{ includeRealtime: boolean; options: LanguageOptions } | null>(null);
  const [reading, setLoading] = useState(true);
  const options = capabilities?.includeRealtime === includeRealtime ? capabilities.options : null;
  const loading = reading || Boolean(capabilities && capabilities.includeRealtime !== includeRealtime);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const field = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
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
          || !Array.isArray(result.providers) || result.providers.some((provider) => typeof provider !== "string")
          || [result.supports_auto, result.supports_multiple, result.supports_strict].some((flag) => typeof flag !== "boolean")) throw new Error();
        if ((result.supports_translation !== undefined && typeof result.supports_translation !== "boolean")
          || (result.translation_languages !== undefined && (!Array.isArray(result.translation_languages)
            || result.translation_languages.some((code) => typeof code !== "string" || !/^[a-z]{2,3}$/.test(code))))) throw new Error();
        if (active) setCapabilities({ includeRealtime, options: result });
      } catch {
        if (active) { setCapabilities(null); setError("対応言語を取得できませんでした。再取得してください。"); }
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [includeRealtime, revision]);
  useEffect(() => {
    if (!open) return;
    searchInput.current?.focus();
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !field.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open]);
  const hints = value.hints;
  const controlsDisabled = disabled || loading || !options;
  const query = search.normalize("NFKC").trim().toLocaleLowerCase();
  const languages = [...new Set(options?.languages)].sort((a, b) => {
    const priority = (code: string) => code === "ja" ? 0 : code === "en" ? 1 : 2;
    return priority(a) - priority(b);
  }).filter((code) => `${names.of(code)} ${englishNames.of(code)} ${code}`.normalize("NFKC").toLocaleLowerCase().includes(query));
  const blockedProviders = options?.providers.filter((provider) => provider !== "soniox")
    .map((provider) => providerNames[provider] ?? "現在のエンジン").join("・");
  const autoReason = `${blockedProviders || "現在のエンジン"}を使用しているため、自動判定は利用できません。`;
  function changeHints(next: string[]) { onChange({ ...value, hints: next, strict: next.length > 0 && value.strict }); }
  function removeLanguage(code: string) {
    if (controlsDisabled || !hints?.length || (hints.length === 1 && !options?.supports_auto)) return;
    changeHints(hints.filter((item) => item !== code));
    trigger.current?.focus();
  }
  function closePicker() { setOpen(false); trigger.current?.focus(); }
  function chooseLanguage(code: string) {
    if (controlsDisabled) return;
    if (!options.supports_multiple) {
      changeHints([code]);
      closePicker();
    } else if (hints?.includes(code)) {
      if (hints.length > 1 || options.supports_auto) changeHints(hints.filter((item) => item !== code));
    } else {
      changeHints([...(hints ?? []), code]);
    }
  }
  function handlePickerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.target === searchInput.current && event.key === "Enter") {
      event.preventDefault(); // Searching inside either meeting form must not submit it.
      return;
    }
    const fromSearch = event.target === searchInput.current;
    if (fromSearch && !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-language-option]:not(:disabled)") ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : fromSearch ? event.key === "ArrowDown" ? 0 : buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  const unavailable = options && hints !== null && (
    (!hints.length && !options.supports_auto) || (hints.length > 1 && !options.supports_multiple)
    || hints.some((code) => !options.languages.includes(code)) || (value.strict && !options.supports_strict)
  );
  return <fieldset ref={field} className={styles.fields} aria-busy={loading} onKeyDownCapture={(event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation(); closePicker();
    }
  }}>
    <legend>会議で話す言語</legend>
    <div className={styles.selected} role="group" aria-label="文字起こし言語">
      {hints == null ? <span className={styles.chip}>従来の設定を維持</span>
        : hints.map((code) => <span key={code} className={styles.chip}>
            <span>{names.of(code) ?? code}</span>
            {(hints.length > 1 || options?.supports_auto) && <button type="button" disabled={controlsDisabled} aria-label={`${names.of(code) ?? code}を外す`} onClick={() => removeLanguage(code)}><X size={15} aria-hidden="true" /></button>}
          </span>)}
      <button ref={trigger} type="button" className={styles.pickerButton} aria-label="言語を選ぶ" aria-expanded={open} aria-controls={`${id}-picker`} disabled={controlsDisabled} onClick={() => { setSearch(""); setOpen((previous) => !previous); }}>
        <Plus size={16} aria-hidden="true" /><span>言語を選ぶ</span>
      </button>
    </div>
    <div ref={panel} id={`${id}-picker`} className={styles.picker} role="group" aria-label="言語の選択" hidden={!open} onKeyDown={handlePickerKeyDown}>
      <label className={styles.search}>
        <Search size={17} aria-hidden="true" />
        <input ref={searchInput} type="search" aria-label="言語を検索" placeholder="日本語、English、ja…" value={search} disabled={controlsDisabled} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className={styles.choices}>
        <button type="button" className={styles.option} data-language-option aria-label="自動判定を選択" aria-pressed={hints?.length === 0} aria-describedby={!options?.supports_auto ? `${id}-auto-reason` : undefined} disabled={controlsDisabled || !options.supports_auto} onClick={() => { changeHints([]); closePicker(); }}>
          <span className={styles.check} aria-hidden="true">{hints?.length === 0 && <Check size={18} />}</span>
          <span>自動判定</span><small>言語ヒントなし</small>
        </button>
        {languages.map((code) => <button key={code} type="button" className={styles.option} data-language-option aria-label={`${names.of(code) ?? code}を選択`} aria-pressed={hints?.includes(code) ?? false} disabled={controlsDisabled} onClick={() => chooseLanguage(code)}>
          <span className={styles.check} aria-hidden="true">{hints?.includes(code) && <Check size={18} />}</span>
          <span>{names.of(code) ?? code}</span><small>{code}</small>
        </button>)}
        {options && !loading && languages.length === 0 && <p role="status">該当する言語がありません。別の名前やコードで検索してください。</p>}
      </div>
      <div className={styles.pickerFooter}>
        <p>{options?.supports_multiple ? "複数選択できます。選択中の言語を押すと外せます。すべて外すと自動判定になります。" : "言語を選ぶと、現在の言語と入れ替わります。"}</p>
        <button type="button" className={styles.closeButton} onClick={closePicker}>閉じる</button>
      </div>
    </div>
    {options && !options.supports_auto && <p id={`${id}-auto-reason`}>{autoReason} {includeRealtime ? "リアルタイム・確定版の両方" : "確定版"}をSonioxにすると、自動判定と複数言語を使えます。</p>}
    <p id={`${id}-hint`}>{options?.supports_auto && hints?.length === 0 ? "言語を選択しない場合は自動判定します。" : "選択した言語を認識のヒントに使います。Sonioxでは他の言語も認識できます。"}</p>
    <details className={styles.advanced}>
      <summary><ChevronDown size={16} aria-hidden="true" /><span>詳細設定</span><span className={styles.strictStatus} data-active={value.strict}>Strict {value.strict ? "ON" : "OFF"}</span></summary>
      <div className={styles.advancedContent}>
        <label className={styles.toggle}>
          <span><strong>選択した言語に限定する</strong><small>Strict language hints · Soniox用。完全な保証ではありません。通常はOFFを推奨します。</small></span>
          <input type="checkbox" role="switch" aria-label="選択した言語に限定する" aria-describedby={`${id}-hint`} checked={value.strict} disabled={controlsDisabled || (!options.supports_strict && !value.strict) || !hints?.length} onChange={(event) => onChange({ ...value, strict: event.target.checked })} />
        </label>
        {hints?.length === 0 && <p>自動判定ではStrictを使用しません。言語を選ぶと設定できます。</p>}
        {options && !options.supports_strict && <p>StrictはSonioxで利用できます。現在の構成ではONにできません。</p>}
        {value.strict && (hints?.length ?? 0) > 1 && <p>Strictは1つの言語で最も安定します。複数言語では認識が不安定になる場合があります。</p>}
      </div>
    </details>
    {includeRealtime && <MeetingTranslationFields value={value.translation ?? null} onChange={(translation) => onChange({ ...value, translation })} languages={options?.translation_languages ?? options?.languages ?? []} supported={options?.supports_translation === true} disabled={controlsDisabled || translationLocked} />}
    {includeRealtime && translationLocked && <p>録音開始後は翻訳設定を変更できません。録音開始時の設定を使用します。</p>}
    {value.translation?.type === "two_way" && value.strict && <p>双方向で話す場合は、言語ヒントに両方の言語を選ぶか、StrictをOFFにしてください。</p>}
    {unavailable && <p role="alert">選択中の言語設定は現在のエンジンで使用できません。言語設定を選び直してください。</p>}
    {loading && <p role="status">対応言語を確認中…</p>}
    {error && <div className={styles.error}><p role="alert">{error}</p><button type="button" disabled={disabled} onClick={() => setRevision((previous) => previous + 1)}>再取得</button></div>}
  </fieldset>;
}
