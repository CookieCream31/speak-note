"use client";

import { useState } from "react";
import { knowledgeApi, type Project } from "@/lib/api";
import styles from "./new-meeting-project-field.module.css";

export function NewMeetingProjectField({ projects, initialProjectId, disabled, onCreated, onBusyChange }: {
  projects: Project[];
  initialProjectId: string | null;
  disabled: boolean;
  onCreated: (project: Project) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState(initialProjectId ?? "");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const parents = projects.filter((project) => !project.parent_id);

  function toggle() {
    setOpen(!open); setError("");
    if (!open) {
      const selected = projects.find((project) => project.id === selectedId);
      setParentId(selected?.parent_id ?? selected?.id ?? "");
    }
  }

  async function create() {
    if (saving || disabled || !name.trim()) return;
    setSaving(true); setError(""); onBusyChange(true);
    try {
      const project = await knowledgeApi.saveProject(null, {
        name: name.trim(), notes: "", parent_id: parentId || null, profile_id: null,
      });
      onCreated(project); setSelectedId(project.id); setName(""); setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "プロジェクトを作成できませんでした");
    } finally { setSaving(false); onBusyChange(false); }
  }

  return <div className={styles.field}>
    <div className={styles.heading}>
      <label htmlFor="meeting-project-select">プロジェクト</label>
      <button type="button" onClick={toggle} disabled={disabled || saving} aria-expanded={open} aria-controls="new-meeting-project-editor">{open ? "閉じる" : "＋ 新規作成"}</button>
    </div>
    <select id="meeting-project-select" name="project_id" value={selectedId} disabled={disabled || saving} onChange={(event) => setSelectedId(event.target.value)}>
      <option value="">指定しない</option>
      {parents.map((parent) => <optgroup key={parent.id} label={parent.name}>
        <option value={parent.id}>{parent.name}</option>
        {projects.filter((child) => child.parent_id === parent.id).map((child) => <option key={child.id} value={child.id}>↳ {child.name}</option>)}
      </optgroup>)}
    </select>
    {open && <div id="new-meeting-project-editor" className={styles.editor}>
      <label htmlFor="new-meeting-project-name">プロジェクト名</label>
      <input id="new-meeting-project-name" value={name} maxLength={100} disabled={disabled || saving} placeholder="例：就活、A社" autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void create(); } }} />
      <label htmlFor="new-meeting-project-parent">作成先</label>
      <select id="new-meeting-project-parent" value={parentId} disabled={disabled || saving} onChange={(event) => setParentId(event.target.value)}>
        <option value="">親プロジェクトとして作成</option>
        {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.name} の中に作成</option>)}
      </select>
      <p>作成後、この会議のプロジェクトとして自動選択します。背景・資料は後からプロジェクト画面で追加できます。</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button type="button" className={styles.create} disabled={disabled || saving || !name.trim()} onClick={() => void create()}>{saving ? "作成中…" : "作成して選択"}</button>
    </div>}
  </div>;
}
