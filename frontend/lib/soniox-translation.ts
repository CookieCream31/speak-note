import type { SonioxResponse, SonioxToken } from "./soniox-speech-stream";

export interface LiveTranslationResult {
  resultId: string; text: string; sourceLanguage: string; targetLanguage: string;
  speakerLabel: string;
}

/** Translation tokens are ordered captions, without audio timestamps or evidence IDs. */
export class SonioxTranslationAccumulator {
  private pending: SonioxToken[] = [];
  private sequence = 0;
  constructor(private prefix: string) {}
  get resultId() { return `${this.prefix}:translation:${this.sequence}`; }
  private result(tokens: SonioxToken[]): LiveTranslationResult | null {
    const text = tokens.map((token) => token.text).join("").trim();
    const first = tokens[0];
    if (!text || !first?.language || !first.source_language) return null;
    return { resultId: this.resultId, text, sourceLanguage: first.source_language,
      targetLanguage: first.language,
      speakerLabel: first.speaker ? `SONIOX_${this.prefix}_${first.speaker}` : "SPEAKER_UNKNOWN" };
  }
  accept(response: SonioxResponse) {
    const finals: LiveTranslationResult[] = [];
    const drafts: SonioxToken[] = [];
    const flush = () => {
      const result = this.result(this.pending);
      if (result) { finals.push(result); this.sequence += 1; }
      this.pending = [];
    };
    for (const token of response.tokens ?? []) {
      if (token.text === "<end>" || token.text === "<fin>") {
        if (token.is_final) flush();
        continue;
      }
      if (token.translation_status !== "translation") {
        if (token.is_final) flush();
        continue;
      }
      const first = this.pending[0] ?? drafts[0];
      if (first && (first.language !== token.language || first.source_language !== token.source_language || first.speaker !== token.speaker)) {
        flush(); drafts.length = 0;
      }
      if (token.is_final) this.pending.push(token);
      else drafts.push(token);
    }
    if (response.finished) flush();
    return { finals, interim: response.finished ? null : this.result([...this.pending, ...drafts]) };
  }
  flush() { return this.accept({ finished: true }).finals; }
}
