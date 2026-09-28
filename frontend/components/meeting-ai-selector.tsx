"use client";

import { useState } from "react";

import type { AIProfile } from "@/lib/api";

import styles from "./meeting-ai-selector.module.css";

interface MeetingAISelectorProps {
  meetingId: string;
  currentProfileId: string | null;
  disabled: boolean;
  profiles: AIProfile[];
}

export function MeetingAISelector({
  meetingId,
  currentProfileId,
  disabled,
  profiles,
}: MeetingAISelectorProps) {
  const initialValue = disabled ? "none" : currentProfileId ?? "default";
  const [value, setValue] = useState(initialValue);
  const [status, setStatus] = useState("");

  async function update(nextValue: string) {
    setValue(nextValue);
    setStatus("保存中");
    const response = await fetch(`/api/v1/meetings/${meetingId}/ai-profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: nextValue === "none" ? "none" : nextValue === "default" ? "default" : "profile",
        profile_id: nextValue === "none" || nextValue === "default" ? null : nextValue,
      }),
    });
    if (!response.ok) {
      setValue(initialValue);
      setStatus("保存できませんでした");
      return;
    }
    setStatus("保存済み");
  }

  return (
    <label className={styles.selector}>
      <span>この会議で使うAI</span>
      <select value={value} onChange={(event) => void update(event.target.value)}>
        <option value="default">Default Profile</option>
        <option value="none">AIなし</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>{profile.name}</option>
        ))}
      </select>
      <small>{status}</small>
    </label>
  );
}
