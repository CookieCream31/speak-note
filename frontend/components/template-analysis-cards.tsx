"use client";

import type { ReactNode } from "react";

import type { MeetingTemplateCard, TemplateFieldType } from "@/lib/api";

import styles from "./template-analysis-cards.module.css";

export interface TemplateDisplayValue {
  card_id: string;
  row_id: string;
  field_id: string;
  field_type: TemplateFieldType;
  value?: string | number | boolean | null;
  text_value?: string | null;
  number_value?: number | null;
  boolean_value?: boolean | null;
  evidence_segment_ids: string[];
}

function fieldValue(value: TemplateDisplayValue): string {
  const raw = value.value !== undefined
    ? value.value
    : value.field_type === "number"
      ? value.number_value
      : value.field_type === "boolean"
        ? value.boolean_value
        : value.text_value;
  if (raw === null || raw === undefined || raw === "") return "未入力";
  if (typeof raw === "boolean") return raw ? "はい" : "いいえ";
  return String(raw);
}

function TemplateFields({
  fields,
  values,
  onSelectEvidence,
}: {
  fields: MeetingTemplateCard["fields"];
  values: TemplateDisplayValue[];
  onSelectEvidence: (segmentId: string) => void;
}) {
  if (fields.length === 0) return null;
  const valuesByField = new Map(values.map((value) => [value.field_id, value]));
  return (
    <dl className={styles.fields}>
      {fields.map((field) => {
        const value = valuesByField.get(field.id);
        return (
          <div className={styles.field} key={field.id}>
            <dt>{field.name}</dt>
            <dd>{value ? fieldValue(value) : "未入力"}</dd>
            {value?.evidence_segment_ids.length ? (
              <div className={styles.evidence} aria-label={`${field.name}の根拠`}>
                {value.evidence_segment_ids.map((id) => (
                  <button type="button" key={id} onClick={() => onSelectEvidence(id)}>
                    根拠を確認
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}

/** Renders cards using the immutable definition saved with the analysis. */
export function TemplateAnalysisCards({
  cards,
  values,
  coreRows,
  onSelectEvidence,
}: {
  cards: MeetingTemplateCard[];
  values: TemplateDisplayValue[];
  coreRows: Record<string, Array<{ rowId: string; content: ReactNode }>>;
  onSelectEvidence: (segmentId: string) => void;
}) {
  const visibleCards = cards.filter((card) => card.visible);
  const rowsByCard = new Map<string, Map<string, TemplateDisplayValue[]>>();
  for (const value of values) {
    let rows = rowsByCard.get(value.card_id);
    if (!rows) {
      rows = new Map();
      rowsByCard.set(value.card_id, rows);
    }
    const row = rows.get(value.row_id) ?? [];
    row.push(value);
    rows.set(value.row_id, row);
  }

  const renderedCards = visibleCards.flatMap((card) => {
    const cardRows = rowsByCard.get(card.id) ?? new Map<string, TemplateDisplayValue[]>();
    const core = card.core_kind ? coreRows[card.core_kind] ?? [] : [];
    const customRows = card.core_kind ? [] : [...cardRows.entries()]
      .filter(([, rowValues]) => rowValues.some((value) => fieldValue(value) !== "未入力"));
    const hasRows = card.core_kind ? core.length > 0 : customRows.length > 0;
    if (!hasRows && !card.show_when_empty) return [];

    return [(
      <article
        className={`${styles.card} ${card.core_kind === "summary" ? styles.summaryCard : ""}`}
        key={card.id}
        data-template-card={card.id}
        data-template-kind={card.core_kind ?? undefined}
      >
        <h3>{card.title}</h3>
        {card.core_kind ? (
          core.length > 0 ? (
            <div className={styles.coreRows}>
              {core.map(({ rowId, content }) => (
                <div className={styles.row} key={rowId}>
                  {content}
                  <TemplateFields
                    fields={card.fields}
                    values={cardRows.get(rowId) ?? []}
                    onSelectEvidence={onSelectEvidence}
                  />
                </div>
              ))}
            </div>
          ) : <p className={styles.empty}>まだありません</p>
        ) : (
          customRows.length > 0 ? (
            <div className={styles.coreRows}>
              {customRows.map(([rowId, rowValues]) => (
                <div className={styles.row} key={rowId}>
                  <TemplateFields
                    fields={card.fields}
                    values={rowValues}
                    onSelectEvidence={onSelectEvidence}
                  />
                </div>
              ))}
            </div>
          ) : <p className={styles.empty}>まだありません</p>
        )}
      </article>
    )];
  });

  if (renderedCards.length === 0) return null;
  return <div className={styles.grid}>{renderedCards}</div>;
}

