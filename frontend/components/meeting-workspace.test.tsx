import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TranscriptRuntime } from "./transcript-player";
import { MeetingWorkspace } from "./meeting-workspace";

describe("MeetingWorkspace", () => {
  it("renders the player before the tabs and selects the summary by default", () => {
    const html = renderToStaticMarkup(
      <MeetingWorkspace
        meetingId="meeting-1"
        playback={{
          mediaUrl: "/api/media/video",
          downloadUrl: "/api/media/video/download",
          mediaKind: "video",
          durationMs: 60_000,
          chapters: [],
          turns: [{
            id: "turn-1",
            startMs: 0,
            speakerId: "speaker-1",
            speakerName: "話者",
            words: [{
              id: "word-1",
              startMs: 0,
              endMs: 500,
              text: "テスト",
              exact: true,
            }],
          }],
        }}
        notes={<div>SUMMARY_CONTENT</div>}
        questions={<div>QUESTION_CONTENT</div>}
        transcriptHeader={<div>TRANSCRIPT_HEADER</div>}
        transcriptFooter={<div>TRANSCRIPT_FOOTER</div>}
        tools={<div>TOOLS_CONTENT</div>}
      />,
    );

    expect(html.indexOf("data-meeting-player")).toBeLessThan(
      html.indexOf('role="tablist"'),
    );
    expect(html).toContain(
      'id="meeting-view-tab-notes" role="tab" aria-selected="true"',
    );
    expect(html).toContain('id="meeting-view-tab-questions"');
    expect(html).toContain(
      'id="meeting-view-panel-questions" role="tabpanel" aria-labelledby="meeting-view-tab-questions" hidden=""',
    );
    expect(html).toContain(
      'id="meeting-view-panel-transcript" role="tabpanel" aria-labelledby="meeting-view-tab-transcript" hidden=""',
    );
    expect(html.indexOf("TRANSCRIPT_HEADER")).toBeLessThan(
      html.indexOf("data-transcript-document"),
    );
    expect(html.indexOf("data-transcript-document")).toBeLessThan(
      html.indexOf("TRANSCRIPT_FOOTER"),
    );
    expect(html).toContain("data-follow-status");
    expect(html).toContain("data-follow-resume");
    expect(html).toContain(
      'aria-keyshortcuts="Space K J L ArrowLeft ArrowRight F M C Shift+Period Shift+Comma"',
    );
    expect(html).toContain("data-subtitle-overlay");
    expect(html).toContain("data-subtitle-toggle");
    expect(html).toContain("data-playback-rate");
    expect(html).toContain("data-playback-rate-value");
    expect(html).toContain("data-secondary-button-group");
    expect(html).toContain("画質・字幕の設定");
    expect(html).toContain('role="dialog" aria-label="再生設定" data-page="root" hidden=""');
    expect(html.indexOf("data-playback-rate")).toBeLessThan(
      html.indexOf("data-secondary-button-group"),
    );
    expect(html.indexOf('<option value="2"')).toBeLessThan(
      html.indexOf('<option value="1.75"'),
    );
    expect(html.indexOf('<option value="1.75"')).toBeLessThan(
      html.indexOf('<option value="1.5"'),
    );
    expect(html.indexOf('<option value="1.5"')).toBeLessThan(
      html.indexOf('<option value="1.25"'),
    );
    expect(html.indexOf('<option value="1.25"')).toBeLessThan(
      html.indexOf('<option value="1"'),
    );
    expect(html.indexOf('<option value="1"')).toBeLessThan(
      html.indexOf('<option value="0.75"'),
    );
    expect(html.indexOf('<option value="0.75"')).toBeLessThan(
      html.indexOf('<option value="0.5"'),
    );
    expect(html).toContain("data-volume-slider");
    expect(html).toContain("data-vector-volume-icon");
    expect(html.indexOf("data-volume-toggle")).toBeLessThan(
      html.indexOf("data-media-time"),
    );
    expect(html).toContain('<option value="0.5">0.5×</option>');
    expect(html).toContain('<option value="1.25">1.25×</option>');
    expect(html).toContain('<option value="1.75">1.75×</option>');
    expect(html).toContain('<option value="2">2×</option>');
    expect(html).toContain("data-subtitle-cue");
    expect(html).toContain('data-subtitle-speaker-id="speaker-1"');
    expect(html).toContain("話者の名前を変更");
    expect(html).toContain('href="/api/media/video/download"');
    expect(html).toContain('aria-label="この動画をダウンロード"');
    expect(html).not.toContain("映像を確認する");
    expect(html).not.toContain("data-auto-follow");
  });

  it("loads the current transcript follow runtime", () => {
    const runtime = TranscriptRuntime({ turns: [] });
    const children = Children.toArray(runtime.props.children) as ReactElement<{ src?: string }>[];

    expect(children[1]?.props.src).toBe("/transcript-player.js?v=20260924-2");
  });

  it("renders audio playback as a persistent custom control bar", () => {
    const html = renderToStaticMarkup(
      <MeetingWorkspace
        meetingId="meeting-1"
        playback={{
          mediaUrl: "/api/media/audio",
          downloadUrl: "/api/media/audio/download",
          mediaKind: "audio",
          durationMs: 60_000,
          chapters: [{
            id: "chapter-1",
            title: "挨拶",
            startMs: 0,
            endMs: 20_000,
          }, {
            id: "chapter-2",
            title: "本題",
            startMs: 20_000,
            endMs: 45_000,
          }, {
            id: "chapter-3",
            title: "まとめ",
            startMs: 45_000,
            endMs: 60_000,
          }],
          turns: [],
        }}
        notes={<div>SUMMARY_CONTENT</div>}
        questions={<div>QUESTION_CONTENT</div>}
        transcriptHeader={null}
        transcriptFooter={null}
        tools={null}
      />,
    );

    expect(html).toContain('data-media-kind="audio"');
    expect(html).toContain('aria-label="会議音声プレイヤー"');
    expect(html).toContain("data-custom-media-controls");
    expect(html).toContain("data-chapter-track");
    expect(html).toContain('data-chapter-count="3"');
    expect(html.match(/data-chapter-segment/g)).toHaveLength(3);
    expect(html).toContain('data-skip-seconds="-10"');
    expect(html).toContain('data-skip-seconds="10"');
    expect(html).toContain("data-playback-rate");
    expect(html).toContain('<option value="0.5">0.5×</option>');
    expect(html).toContain('<option value="1.25">1.25×</option>');
    expect(html).toContain('<option value="1.75">1.75×</option>');
    expect(html).toContain("data-play-toggle");
    expect(html).toContain('href="/api/media/audio/download"');
    expect(html).toContain('aria-label="この音声をダウンロード"');
    expect(html).toContain(
      'aria-keyshortcuts="Space K J L ArrowLeft ArrowRight M Shift+Period Shift+Comma"',
    );
    expect(html).not.toContain("data-subtitle-toggle");
    expect(html).not.toContain("<audio controls=");
  });
});
