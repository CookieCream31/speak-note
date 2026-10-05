"use client";

import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import styles from "./meeting-template-manager.module.css";
import type { MeetingTemplate, MeetingTemplateCard, MeetingTemplateDefinition, MeetingTemplateField, TemplateFieldType } from "@/lib/api";

const blankDefinition: MeetingTemplateDefinition = { realtime: [], final: [] };
const viewNames = { realtime: "リアルタイム", final: "確定後" } as const;
const viewDescriptions = {
  realtime: "録画・録音中のリアルタイム解析に表示するカードと順番",
  final: "会議後の議事録に表示するカードと順番",
} as const;
const fieldTypeNames: Record<TemplateFieldType, string> = {
  short_text: "短文", long_text: "長文", number: "数値", date: "日付",
  boolean: "はい／いいえ", single_select: "単一選択",
};
const coreKinds = [
  ["", "独自カード"], ["summary", "要約"], ["decision", "決定事項"],
  ["action_item", "次のアクション"], ["open_question", "確認ポイント"],
  ["important_point", "重要情報"], ["chapter", "チャプター"],
  ["suggested_question", "質問候補"], ["highlight", "重要箇所"],
] as const;

function stableId(): string { return crypto.randomUUID().replaceAll("-", ""); }

async function send(path: string, method: string, body?: unknown): Promise<MeetingTemplate | null> {
  const response = await fetch("/api/v1" + path, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = "保存できませんでした (" + response.status + ")";
    try {
      const payload = await response.json() as { detail?: unknown };
      if (typeof payload.detail === "string") message = payload.detail;
      else if (Array.isArray(payload.detail)) {
        const first = payload.detail[0] as { msg?: unknown } | undefined;
        if (typeof first?.msg === "string") message = first.msg;
      }
    } catch { /* status message is enough */ }
    throw new Error(message);
  }
  return response.status === 204 ? null : await response.json() as MeetingTemplate;
}

export function MeetingTemplateManager({ initialTemplates }: { initialTemplates: MeetingTemplate[] }) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [selectedId, setSelectedId] = useState((initialTemplates.find((item) => item.is_default) ?? initialTemplates[0])?.id ?? "");
  const [name, setName] = useState((initialTemplates.find((item) => item.is_default) ?? initialTemplates[0])?.name ?? "");
  const [definition, setDefinition] = useState<MeetingTemplateDefinition>((initialTemplates.find((item) => item.is_default) ?? initialTemplates[0])?.definition ?? blankDefinition);
  const [view, setView] = useState<"realtime" | "final">("realtime");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // Cards show a one-line summary; their editors stay in the DOM and are revealed on demand.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const selected = useMemo(() => templates.find((item) => item.id === selectedId) ?? null, [templates, selectedId]);

  function selectTemplate(id: string) {
    const item = templates.find((template) => template.id === id);
    setSelectedId(id); setName(item?.name ?? ""); setDefinition(item?.definition ?? blankDefinition);
    setMessage(""); setError("");
  }
  function updateCards(update: (cards: MeetingTemplateCard[]) => MeetingTemplateCard[]) {
    setDefinition((current) => ({ ...current, [view]: update(current[view]) }));
  }
  function updateCard(id: string, update: (card: MeetingTemplateCard) => MeetingTemplateCard) {
    updateCards((cards) => cards.map((card) => card.id === id ? update(card) : card));
  }
  function addCard() {
    const id = stableId();
    updateCards((cards) => [...cards, { id, title: "新しいカード", visible: true,
      show_when_empty: false, core_kind: null, fields: [] }]);
    setExpanded((current) => new Set(current).add(id));
  }
  function toggleCard(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function startNewTemplate() {
    setSelectedId(""); setName("");
    setDefinition(selected?.definition ?? initialTemplates.find((item) => item.is_default)?.definition ?? initialTemplates[0]?.definition ?? blankDefinition);
    setMessage(""); setError("");
  }
  function addField(card: MeetingTemplateCard) {
    const field: MeetingTemplateField = { id: stableId(), name: "新しい項目", type: "short_text", options: [], required: false };
    updateCard(card.id, (current) => ({ ...current, fields: [...current.fields, field] }));
  }
  function moveCard(index: number, delta: number) {
    updateCards((cards) => {
      const target = index + delta;
      if (target < 0 || target >= cards.length) return cards;
      const next = [...cards]; [next[index], next[target]] = [next[target], next[index]]; return next;
    });
  }
  function moveField(card: MeetingTemplateCard, index: number, delta: number) {
    updateCard(card.id, (current) => {
      const target = index + delta;
      if (target < 0 || target >= current.fields.length) return current;
      const fields = [...current.fields];
      [fields[index], fields[target]] = [fields[target], fields[index]];
      return { ...current, fields };
    });
  }
  async function save() {
    if (!name.trim()) { setError("テンプレート名を入力してください"); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const updated = await send(selectedId ? "/meeting-templates/" + selectedId : "/meeting-templates",
        selectedId ? "PATCH" : "POST",
        selectedId ? { name: name.trim(), definition, expected_revision: selected?.revision } : { name: name.trim(), definition });
      if (updated) {
        setTemplates((items) => selectedId ? items.map((item) => item.id === updated.id ? updated : item) : [...items, updated]);
        setSelectedId(updated.id); setName(updated.name); setDefinition(updated.definition);
      }
      setMessage("保存しました。新しい会議や、このテンプレートを選び直した再生成に適用されます。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存できませんでした"); }
    finally { setBusy(false); }
  }
  async function makeDefault() {
    if (!selected) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const updated = await send("/meeting-templates/" + selected.id, "PATCH", { is_default: true, expected_revision: selected.revision });
      if (updated) setTemplates((items) => items.map((item) => item.id === updated.id ? updated : { ...item, is_default: false }));
      setMessage("既定テンプレートを変更しました。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "変更できませんでした"); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!selected || selected.is_default || !window.confirm("「" + selected.name + "」を削除しますか？")) return;
    setBusy(true); setError("");
    try {
      await send("/meeting-templates/" + selected.id, "DELETE");
      const remaining = templates.filter((item) => item.id !== selected.id);
      setTemplates(remaining); selectTemplate(remaining[0]?.id ?? "");
      setMessage("削除しました。既存会議のsnapshotは保持されます。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "削除できませんでした"); }
    finally { setBusy(false); }
  }
  const cards = definition[view];

  const coreLabel = (kind: MeetingTemplateCard["core_kind"]) =>
    coreKinds.find(([value]) => value === (kind ?? ""))?.[1] ?? "独自カード";

  return (
    <section className={styles.editor} aria-label="議事録テンプレート">
      <aside className={styles.templateList}>
        <div className={styles.listTitle}>
          <span>テンプレート</span>
          <button type="button" aria-label="新しいテンプレート" title="新しいテンプレート" onClick={startNewTemplate}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
        {selectedId === "" && <button type="button" className={`${styles.templateItem} ${styles.activeTemplate}`} aria-current="true">新規テンプレート</button>}
        {templates.map((item) => (
          <button key={item.id} type="button"
            className={`${styles.templateItem} ${item.id === selectedId ? styles.activeTemplate : ""}`}
            aria-current={item.id === selectedId ? "true" : undefined}
            onClick={() => selectTemplate(item.id)}>
            <span>{item.name}</span>
            {item.is_default && <small>既定</small>}
          </button>
        ))}
        {templates.length === 0 && selectedId !== "" && <p className={styles.fieldEmpty}>テンプレートはまだありません</p>}
      </aside>

      <div className={styles.main}>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {message && <p className={styles.success} role="status">{message}</p>}

        <div className={styles.nameRow}>
          <label className={styles.nameField}>
            <span>テンプレート名</span>
            <input aria-label="テンプレート名" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </label>
          {selected && !selected.is_default && <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => void makeDefault()}>既定にする</button>}
        </div>

        <div className={styles.viewRow}>
          <div className={styles.tabs} role="tablist" aria-label="編集する表示">
            {(["realtime", "final"] as const).map((item) => (
              <button className={styles.tab} key={item} type="button" role="tab" aria-selected={view === item} onClick={() => setView(item)}>{viewNames[item]}</button>
            ))}
          </div>
          <span>{viewDescriptions[view]}</span>
        </div>

        <div className={styles.cards}>
          {cards.length === 0 && <p className={styles.fieldEmpty}>カードはまだありません。</p>}
          {cards.map((card, index) => {
            const open = expanded.has(card.id);
            return (
              <article className={styles.card} key={card.id} data-open={open} data-visible={card.visible}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardOrder}>
                    <button className={styles.orderButton} type="button" aria-label="上へ" disabled={index === 0} onClick={() => moveCard(index, -1)}><ChevronUp size={16} aria-hidden="true" /></button>
                    <button className={styles.orderButton} type="button" aria-label="下へ" disabled={index === cards.length - 1} onClick={() => moveCard(index, 1)}><ChevronDown size={16} aria-hidden="true" /></button>
                  </div>
                  <button className={styles.cardToggle} type="button" aria-expanded={open} aria-controls={`template-card-${card.id}`} onClick={() => toggleCard(card.id)}>
                    <strong>{card.title || "（名称なし）"}</strong>
                    <small>{card.visible ? (card.core_kind ? `既存項目：${coreLabel(card.core_kind)}` : "独自カード") : "非表示"}</small>
                  </button>
                  <label className={styles.visibility}>
                    <input type="checkbox" role="switch" aria-label={`${card.title || "カード"}を表示`} checked={card.visible} onChange={(event) => updateCard(card.id, (value) => ({ ...value, visible: event.target.checked }))} />
                  </label>
                  <button className={styles.expandButton} type="button" aria-label={open ? "閉じる" : "編集"} aria-expanded={open} aria-controls={`template-card-${card.id}`} onClick={() => toggleCard(card.id)}>
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                </div>
                <div className={styles.cardBody} id={`template-card-${card.id}`} hidden={!open}>
                  <div className={styles.cardMain}>
                    <label className={styles.cardName}>
                      <span>カード名</span>
                      <input aria-label="カード名" value={card.title} onChange={(event) => updateCard(card.id, (value) => ({ ...value, title: event.target.value }))} />
                    </label>
                    <label className={styles.coreType}>
                      <span>既存項目</span>
                      <select value={card.core_kind ?? ""} onChange={(event) => updateCard(card.id, (value) => ({ ...value, core_kind: (event.target.value || null) as MeetingTemplateCard["core_kind"] }))}>
                        {coreKinds.filter(([kind]) => view === "final" || !["chapter", "suggested_question", "highlight"].includes(kind)).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className={styles.instructions}>
                    <span>AIへの指示</span>
                    <textarea aria-label="AIへの指示" value={card.instructions ?? ""} maxLength={2000}
                      onChange={(event) => updateCard(card.id, (value) => ({ ...value, instructions: event.target.value }))}
                      placeholder="このカードにまとめる内容や書き方" />
                  </label>
                  <div className={styles.fieldSection}>
                    <div className={styles.fieldHeading}><span>追加項目</span><small>このカードに表示する情報を設定</small></div>
                    {card.fields.length === 0 && <p className={styles.fieldEmpty}>追加項目はありません</p>}
                    {card.fields.map((field, fieldIndex) => (
                      <div className={styles.fieldRow} key={field.id}>
                        <div className={styles.fieldOrder}>
                          <button className={styles.orderButton} type="button" aria-label="項目を上へ" disabled={fieldIndex === 0} onClick={() => moveField(card, fieldIndex, -1)}><ChevronUp size={16} aria-hidden="true" /></button>
                          <button className={styles.orderButton} type="button" aria-label="項目を下へ" disabled={fieldIndex === card.fields.length - 1} onClick={() => moveField(card, fieldIndex, 1)}><ChevronDown size={16} aria-hidden="true" /></button>
                        </div>
                        <div className={styles.fieldName}>
                          <input aria-label="項目名" value={field.name} onChange={(event) => updateCard(card.id, (value) => ({ ...value, fields: value.fields.map((item) => item.id === field.id ? { ...item, name: event.target.value } : item) }))} />
                        </div>
                        <div className={styles.fieldType}>
                          <select aria-label="項目型" value={field.type} onChange={(event) => updateCard(card.id, (value) => ({ ...value, fields: value.fields.map((item) => item.id === field.id ? { ...item, type: event.target.value as TemplateFieldType, options: event.target.value === "single_select" ? ["高", "中", "低"] : [] } : item) }))}>
                            {Object.entries(fieldTypeNames).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
                          </select>
                        </div>
                        {field.type === "single_select" && (
                          <div className={styles.fieldOptions}>
                            <input aria-label="選択肢" value={field.options.join(", ")} onChange={(event) => updateCard(card.id, (value) => ({ ...value, fields: value.fields.map((item) => item.id === field.id ? { ...item, options: event.target.value.split(",").map((option) => option.trim()).filter(Boolean) } : item) }))} placeholder="選択肢をカンマ区切り" />
                          </div>
                        )}
                        <button className={styles.fieldDelete} type="button" aria-label="項目を削除" onClick={() => updateCard(card.id, (value) => ({ ...value, fields: value.fields.filter((item) => item.id !== field.id) }))}>削除</button>
                      </div>
                    ))}
                    <button className={styles.addFieldButton} type="button" onClick={() => addField(card)}>＋ 項目を追加</button>
                  </div>
                  <button className={styles.cardDelete} type="button" onClick={() => updateCards((items) => items.filter((item) => item.id !== card.id))}>カードを削除</button>
                </div>
              </article>
            );
          })}
        </div>
        <button className={styles.addCardButton} type="button" onClick={addCard}>＋ カードを追加</button>
      </div>

      <footer className={styles.footer}>
        <span>過去の議事録は変わりません。新しい会議・再生成で適用します。</span>
        {selected && !selected.is_default && <button className={styles.deleteButton} type="button" disabled={busy} onClick={() => void remove()}>テンプレートを削除</button>}
        <button className={styles.primaryButton} type="button" disabled={busy} onClick={() => void save()}>保存</button>
      </footer>
    </section>
  );
}
