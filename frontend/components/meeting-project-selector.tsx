"use client";

import { useEffect, useState } from "react";

import { knowledgeApi, meetingsApi, type Project } from "@/lib/api";
import styles from "./meeting-ai-selector.module.css";

export function MeetingProjectSelector({ meetingId, currentProjectId }: {
  meetingId: string; currentProjectId: string | null;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [value, setValue] = useState(currentProjectId ?? "");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void knowledgeApi.projects().then(setProjects).catch(() => setStatus("プロジェクトを取得できません"));
  }, []);

  async function update(next: string) {
    if (saving) return;
    setSaving(true);
    const previous = value;
    setValue(next);
    setStatus("保存中");
    try {
      await meetingsApi.update(meetingId, { project_id: next || null });
      setStatus("保存済み");
    } catch {
      setValue(previous);
      setStatus("保存できませんでした");
    } finally { setSaving(false); }
  }

  return <label className={styles.selector}>
    <span>プロジェクト</span>
    <select value={value} disabled={saving} onChange={(event) => void update(event.target.value)}>
      <option value="">指定しない</option>
      {projects.filter((project) => !project.parent_id).map((parent) => <optgroup key={parent.id} label={parent.name}>
        <option value={parent.id}>{parent.name}</option>
        {projects.filter((child) => child.parent_id === parent.id).map((child) =>
          <option key={child.id} value={child.id}>↳ {child.name}</option>)}
      </optgroup>)}
    </select>
    <small>{status}</small>
  </label>;
}
