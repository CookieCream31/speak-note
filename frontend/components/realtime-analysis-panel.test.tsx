import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RealtimeAnalysisEvidence, TranscriptSegment } from "@/lib/api";

import {
  composeLiveTranscriptStream,
  EvidenceRange,
  groupLiveTranscriptSegments,
  LiveTranscriptDocument,
  LiveInterimTranscript,
  mergeLiveTranscriptSegments,
  RealtimeAnalysisPanel,
  type StreamingTranscriptSegment,
  upsertStreamingTranscriptSegment,
} from "./realtime-analysis-panel";

describe("RealtimeAnalysisPanel", () => {
  it("lays out the recorder with the live transcript beside analysis and answer assist tabs", () => {
    const html = renderToStaticMarkup(
      <RealtimeAnalysisPanel
        meetingId="meeting-1"
        recorder={<div>RECORDER</div>}
        answerAssist={<div>ASSIST</div>}
      />,
    );
    // Left column: recorder first, then the always-visible live transcript.
    expect(html.indexOf("RECORDER")).toBeLessThan(html.indexOf('aria-label="リアルタイム文字起こし"'));
    expect(html).toContain('aria-label="文字起こし履歴"');
    // Right column: analysis selected, answer assist kept mounted but hidden.
    expect(html).toContain('id="live-analysis-tab" aria-controls="live-analysis-panel" aria-selected="true"');
    expect(html).toContain('id="live-assist-panel" role="tabpanel" aria-labelledby="live-assist-tab" hidden=""');
    expect(html).toContain("ASSIST");
    expect(html).not.toContain('id="realtime-transcript-tab"');
  });
  it("shows the AI summary by default and exposes a transcript tab", () => {
    const html = renderToStaticMarkup(<RealtimeAnalysisPanel meetingId="meeting-1" />);

    expect(html).toContain(
      'id="realtime-summary-tab" aria-controls="realtime-summary-panel" aria-selected="true"',
    );
    expect(html).toContain(
      'id="realtime-transcript-tab" aria-controls="realtime-transcript-panel" aria-selected="false"',
    );
    expect(html).toContain('aria-label="0発言"');
    expect(html).toContain(
      'id="realtime-transcript-panel" role="tabpanel" aria-labelledby="realtime-transcript-tab" hidden=""',
    );
  });

  it("reserves a live tail while recording and removes it after recording", () => {
    const live = renderToStaticMarkup(<LiveInterimTranscript meetingId="tail-test" recording />);
    expect(live).toContain("次の発話を待っています");
    expect(live).toContain("話者は確定後に表示");
    expect(live).not.toContain("SPEAKER_");
    expect(renderToStaticMarkup(
      <LiveInterimTranscript meetingId="tail-test" recording={false} />,
    )).toBe("");
    expect(renderToStaticMarkup(
      <LiveTranscriptDocument segments={[]} hideEmpty />,
    )).toBe("");
  });

  it("keeps the same keyed row while an interim phrase becomes final", () => {
    const interim: StreamingTranscriptSegment = {
      id: "active-phrase", start_ms: 1_000, end_ms: 2_000, text: "認識途中",
      confidence: null, sequence: 0, speaker: null,
      provisional_speaker_label: "SPEAKER_UNKNOWN", words: [], isFinal: false,
    };
    const visible = composeLiveTranscriptStream([], [], interim);
    expect(visible.turns[0].segments[0].id).toBe("active-phrase");
    const html = renderToStaticMarkup(
      <LiveTranscriptDocument segments={visible.segments} turns={visible.turns} />,
    );
    expect(html).toContain("認識中");
    expect(html).toContain("認識途中");
    expect(html).toContain(`id="live-segment-active-phrase"`);
    expect(composeLiveTranscriptStream([], [], null)).toEqual({
      segments: [], turns: [],
    });
  });

  it("keeps browser and persisted evidence anchors after saving", () => {
    const segment: StreamingTranscriptSegment = {
      id: "client-1", persistedId: "db-1", isFinal: true,
      start_ms: 0, end_ms: 1_000, text: "保存済みの文",
      confidence: null, sequence: 0, speaker: null,
      provisional_speaker_label: "SPEAKER_00", words: [],
    };
    const html = renderToStaticMarkup(<LiveTranscriptDocument segments={[segment]} />);
    expect(html).toContain('id="live-segment-client-1"');
    expect(html).toContain('id="live-segment-db-1"');
    expect(html.match(/保存済みの文/g)).toHaveLength(1);
  });

  it("renders live transcript turns like the meeting transcript document", () => {
    const segments: TranscriptSegment[] = [{
      id: "segment-1",
      start_ms: 2_000,
      end_ms: 4_000,
      text: "岡本さんこんにちは",
      confidence: null,
      sequence: 0,
      speaker: {
        id: "speaker-1",
        meeting_id: "meeting-1",
        internal_name: "SPEAKER_00",
        display_name: "岡本",
        created_at: "2026-09-05T00:00:00Z",
      },
      provisional_speaker_label: "SPEAKER_00",
      words: [],
    }];

    const html = renderToStaticMarkup(<LiveTranscriptDocument segments={segments} />);

    expect(html).toContain('id="live-segment-segment-1"');
    expect(html).toContain("0:02");
    expect(html).toContain("岡本");
    expect(html).toContain("岡本さんこんにちは");
    expect(html).toContain("暫定");
  });

  it("groups adjacent segments only while the known speaker stays the same", () => {
    const segment = (
      id: string,
      sequence: number,
      speakerLabel: string,
      text: string,
    ): TranscriptSegment => ({
      id,
      start_ms: sequence * 1_000,
      end_ms: sequence * 1_000 + 900,
      text,
      confidence: null,
      sequence,
      speaker: null,
      provisional_speaker_label: speakerLabel,
      words: [],
    });
    const segments = [
      segment("a-1", 1, "SPEAKER_00", "同じ話者の前半。"),
      segment("a-2", 2, "SPEAKER_00", "同じ話者の後半。"),
      segment("b-1", 3, "SPEAKER_01", "別の話者。"),
      segment("unknown-1", 4, "SPEAKER_UNKNOWN", "判定前。"),
      segment("unknown-2", 5, "SPEAKER_UNKNOWN", "別の判定前。"),
      segment("a-3", 6, "SPEAKER_00", "元の話者に戻る。"),
    ];

    const turns = groupLiveTranscriptSegments(segments);
    expect(turns.map((turn) => turn.segments.map((item) => item.id)))
      .toEqual([["a-1", "a-2"], ["b-1"], ["unknown-1"], ["unknown-2"], ["a-3"]]);

    const html = renderToStaticMarkup(<LiveTranscriptDocument segments={segments} />);
    expect(html.match(/<article/g)).toHaveLength(5);
    expect(html).toContain(`id="live-segment-a-1"`);
    expect(html).toContain(`id="live-segment-a-2"`);
    expect(html).toContain("同じ話者の前半。");
    expect(html).toContain("同じ話者の後半。");
  });

  it("keeps an interim phrase independent until its final speaker is available", () => {
    const stable: TranscriptSegment = {
      id: "stable", start_ms: 1_000, end_ms: 2_000, text: "確定済み。",
      confidence: null, sequence: 0, speaker: null,
      provisional_speaker_label: "SPEAKER_00", words: [],
    };
    const interim: StreamingTranscriptSegment = {
      id: "interim", start_ms: 2_100, end_ms: 3_000, text: "認識中。",
      confidence: null, sequence: Number.MAX_SAFE_INTEGER, speaker: null,
      provisional_speaker_label: "SPEAKER_00", words: [], isFinal: false,
    };

    expect(groupLiveTranscriptSegments([stable, interim])).toHaveLength(2);
    expect(groupLiveTranscriptSegments([
      stable,
      { ...interim, provisional_speaker_label: "SPEAKER_01" },
    ])).toHaveLength(2);
    const finalizedInterim: StreamingTranscriptSegment = { ...interim, isFinal: true };
    expect(groupLiveTranscriptSegments([stable, finalizedInterim])).toHaveLength(1);

    const html = renderToStaticMarkup(<LiveTranscriptDocument segments={[stable, interim]} />);
    expect(html).toContain("認識中");
    expect(html.match(/<article/g)).toHaveLength(2);
  });

  it("merges an immediate interim update into the persisted transcript", () => {
    const persisted: TranscriptSegment = {
      id: "persisted", start_ms: 2_000, end_ms: 3_000, text: "保存済み",
      confidence: null, sequence: 0, speaker: null, provisional_speaker_label: "SPEAKER_00", words: [],
    };
    const interim: TranscriptSegment = {
      id: "interim", start_ms: 3_500, end_ms: 4_000, text: "発話中の文字",
      confidence: null, sequence: Number.MAX_SAFE_INTEGER, speaker: null,
      provisional_speaker_label: "SPEAKER_00", words: [],
    };

    expect(mergeLiveTranscriptSegments([persisted], [interim]).map((item) => item.text))
      .toEqual(["保存済み", "発話中の文字"]);
  });

  it("keeps a finalized browser result visible and prefers the persisted copy", () => {
    const browserResult: StreamingTranscriptSegment = {
      id: "client-result-id", persistedId: "server-segment-id",
      start_ms: 5_000, end_ms: 8_000, text: "確定直後の表示",
      confidence: null, sequence: Number.MAX_SAFE_INTEGER, speaker: null,
      provisional_speaker_label: "SPEAKER_00", words: [],
    };
    const persistedResult: TranscriptSegment = {
      ...browserResult,
      id: "server-segment-id",
      text: "DBに保存された確定結果",
      sequence: 0,
    };

    expect(mergeLiveTranscriptSegments([], [browserResult])).toEqual([browserResult]);
    expect(mergeLiveTranscriptSegments([persistedResult], [browserResult]))
      .toEqual([{ ...persistedResult, id: "client-result-id", isFinal: true }]);
  });

  it("does not let a late interim event replace a finalized phrase", () => {
    const finalized: StreamingTranscriptSegment = {
      id: "phrase-1", persistedId: "server-segment-1",
      start_ms: 1_000, end_ms: 3_000, text: "確定した発話",
      confidence: null, sequence: Number.MAX_SAFE_INTEGER, speaker: null,
      provisional_speaker_label: "SPEAKER_00", words: [], isFinal: true,
    };
    const lateInterim: StreamingTranscriptSegment = {
      ...finalized,
      persistedId: undefined,
      text: "遅れて届いた途中結果",
      isFinal: false,
    };

    expect(upsertStreamingTranscriptSegment([finalized], lateInterim)).toEqual([finalized]);

    const longInterim = { ...finalized, persistedId: undefined, isFinal: false };
    const shorterInterim = { ...lateInterim, text: "短い" };
    expect(upsertStreamingTranscriptSegment([longInterim], shorterInterim)[0].text)
      .toBe("短い");
  });

  it("renders multiple evidence timestamps as one start-to-end range", () => {
    const evidence = new Map<string, RealtimeAnalysisEvidence>([
      ["late", {
        evidence_id: "late",
        segment_id: "segment-late",
        start_ms: 70_000,
        end_ms: 80_000,
        status: "draft",
      }],
      ["early", {
        evidence_id: "early",
        segment_id: "segment-early",
        start_ms: 40_000,
        end_ms: 50_000,
        status: "confirmed",
      }],
    ]);

    const html = renderToStaticMarkup(
      <EvidenceRange
        evidenceIds={["late", "early"]}
        evidence={evidence}
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain("0:40〜1:20 · 暫定");
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});
