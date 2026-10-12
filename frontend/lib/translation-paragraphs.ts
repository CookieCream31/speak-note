import type { LiveTranslation } from "./api";

export interface TranslationParagraph {
  id: string;
  rows: LiveTranslation[];
}

/** Combine consecutive captions for reading without changing stored results. */
export function groupTranslationParagraphs(rows: LiveTranslation[]): TranslationParagraph[] {
  const paragraphs: TranslationParagraph[] = [];
  for (const row of rows) {
    const previous = paragraphs.at(-1);
    const first = previous?.rows[0];
    if (previous && first && first.source_language === row.source_language
      && first.target_language === row.target_language && first.speaker_label === row.speaker_label) {
      previous.rows.push(row);
    } else paragraphs.push({ id: row.result_id, rows: [row] });
  }
  return paragraphs;
}

const NO_WORD_SPACES = new Set(["ja", "zh", "yue", "th", "lo", "km", "my"]);
const LATIN_OR_NUMBER = /[\p{Script=Latin}\p{Number}]/u;

export function translationSeparator(previous: string, next: string, language: string): string {
  if (/\s$|[([{「『（［【“‘]$/u.test(previous)
    || /^[\s,.;:!?%…\)\]\}、。，！？：；）》」』】’']/u.test(next)) return "";
  if (NO_WORD_SPACES.has(language)) {
    return LATIN_OR_NUMBER.test(previous.at(-1) ?? "") && LATIN_OR_NUMBER.test(next[0] ?? "") ? " " : "";
  }
  return " ";
}
