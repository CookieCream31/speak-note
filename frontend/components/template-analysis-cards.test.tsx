import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MeetingTemplateCard } from "@/lib/api";

import { TemplateAnalysisCards } from "./template-analysis-cards";

const cards: MeetingTemplateCard[] = [
  {
    id: "summary-card",
    title: "要約",
    visible: true,
    show_when_empty: false,
    core_kind: "summary",
    fields: [{ id: "confidence", name: "確度", type: "single_select", options: ["高", "低"], required: false }],
  },
  {
    id: "custom-card",
    title: "フォローアップ",
    visible: true,
    show_when_empty: true,
    core_kind: null,
    fields: [{ id: "owner", name: "担当", type: "short_text", options: [], required: false }],
  },
  {
    id: "hidden-card",
    title: "非表示カード",
    visible: false,
    show_when_empty: true,
    core_kind: null,
    fields: [],
  },
];

describe("TemplateAnalysisCards", () => {
  it("renders visible cards in snapshot order with values and evidence controls", () => {
    const onSelectEvidence = vi.fn();
    const html = renderToStaticMarkup(
      <TemplateAnalysisCards
        cards={cards}
        values={[
          {
            card_id: "summary-card",
            row_id: "summary:0",
            field_id: "confidence",
            field_type: "single_select",
            text_value: "高",
            evidence_segment_ids: ["segment-1"],
          },
          {
            card_id: "custom-card",
            row_id: "follow-up:1",
            field_id: "owner",
            field_type: "short_text",
            text_value: "佐藤",
            evidence_segment_ids: [],
          },
        ]}
        coreRows={{ summary: [{ rowId: "summary:0", content: <p>会議の要約</p> }] }}
        onSelectEvidence={onSelectEvidence}
      />,
    );

    expect(html.indexOf("要約")).toBeLessThan(html.indexOf("フォローアップ"));
    expect(html).toContain('data-template-kind="summary"');
    expect(html).toContain("会議の要約");
    expect(html).toContain("確度");
    expect(html).toContain("高");
    expect(html).toContain("佐藤");
    expect(html).toContain('aria-label="確度の根拠"');
    expect(html).toContain("根拠を確認");
    expect(html).not.toContain("非表示カード");
  });

  it("renders configured empty cards while omitting empty cards by default", () => {
    const html = renderToStaticMarkup(
      <TemplateAnalysisCards
        cards={[
          { ...cards[0], show_when_empty: false },
          { ...cards[1], show_when_empty: true },
        ]}
        values={[]}
        coreRows={{}}
        onSelectEvidence={vi.fn()}
      />,
    );

    expect(html).toContain("フォローアップ");
    expect(html).toContain("まだありません");
    expect(html).not.toContain("要約");
  });

  it.each([
    { field_type: "boolean" as const, boolean_value: true, expected: "はい" },
    { field_type: "boolean" as const, boolean_value: false, expected: "いいえ" },
    { field_type: "number" as const, number_value: 0, expected: "0" },
  ])("renders typed $field_type values correctly", ({ field_type, boolean_value, number_value, expected }) => {
    const html = renderToStaticMarkup(
      <TemplateAnalysisCards
        cards={[{
          id: "custom-card",
          title: "値",
          visible: true,
          show_when_empty: false,
          core_kind: null,
          fields: [{ id: "value", name: "フィールド", type: field_type, options: [], required: false }],
        }]}
        values={[{
          card_id: "custom-card",
          row_id: "row:0",
          field_id: "value",
          field_type,
          boolean_value,
          number_value,
          evidence_segment_ids: [],
        }]}
        coreRows={{}}
        onSelectEvidence={vi.fn()}
      />,
    );

    expect(html).toContain(expected);
  });
});

