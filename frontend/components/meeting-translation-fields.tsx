"use client";

import type { RealtimeTranslationConfig } from "@/lib/api";
import styles from "./meeting-translation-fields.module.css";

const names = new Intl.DisplayNames(["ja"], { type: "language" });
export function MeetingTranslationFields({ value, onChange, languages, supported, disabled }: {
  value: RealtimeTranslationConfig | null; onChange: (value: RealtimeTranslationConfig | null) => void;
  languages: string[]; supported: boolean; disabled: boolean;
}) {
  const languageOptions = languages.map((code) => <option key={code} value={code}>{names.of(code) ?? code} ({code})</option>);
  return <div className={styles.fields} role="group" aria-label="リアルタイム翻訳設定">
    <label className={styles.toggle}>
      <span><strong>リアルタイム翻訳</strong><small>原文と翻訳を別々に表示・保存します。</small></span>
      <input type="checkbox" role="switch" aria-label="リアルタイム翻訳を使う" checked={Boolean(value)} disabled={disabled || (!supported && !value)} onChange={(event) => onChange(event.target.checked ? { type: "one_way", target_language: "ja" } : null)} />
    </label>
    {!supported && <p>Sonioxのリアルタイム文字起こしで利用できます。確定版のエンジンは変更する必要がありません。</p>}
    {value && <>
      <label className={styles.select}><span>翻訳方法</span><select aria-label="翻訳方法" value={value.type} disabled={disabled || !supported} onChange={(event) => onChange(event.target.value === "one_way" ? { type: "one_way", target_language: value.type === "two_way" ? value.language_b : "ja" } : { type: "two_way", language_a: "en", language_b: "ja" })}>
        <option value="one_way">一方向 — 1つの言語に翻訳</option><option value="two_way">双方向 — 2つの言語を相互に翻訳</option>
      </select></label>
      {value.type === "one_way" ? <label className={styles.select}><span>翻訳先の言語</span><select aria-label="翻訳先の言語" value={value.target_language} disabled={disabled || !supported} onChange={(event) => onChange({ ...value, target_language: event.target.value })}>{languageOptions}</select></label>
        : <div className={styles.pair}>
          <label className={styles.select}><span>言語A</span><select aria-label="翻訳の言語A" value={value.language_a} disabled={disabled || !supported} onChange={(event) => onChange({ ...value, language_a: event.target.value })}>{languageOptions.filter((item) => item.key !== value.language_b)}</select></label>
          <label className={styles.select}><span>言語B</span><select aria-label="翻訳の言語B" value={value.language_b} disabled={disabled || !supported} onChange={(event) => onChange({ ...value, language_b: event.target.value })}>{languageOptions.filter((item) => item.key !== value.language_a)}</select></label>
        </div>}
      <p>翻訳対象の音声はSonioxへ送信されます。話す言語のヒントと翻訳先は独立した設定です。モデルの翻訳対応は接続前に確認します。</p>
    </>}
  </div>;
}
