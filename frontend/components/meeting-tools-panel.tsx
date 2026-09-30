"use client";

import { Play } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import {
  dispatchSpeakerRenamed,
  SPEAKER_RENAMED_EVENT,
  speakerRenamedDetail,
} from "@/lib/speaker-events";

import type {
  Bookmark,
  Speaker,
  TimelineMarker,
  TranscriptSearchResult,
} from "@/lib/api";

import styles from "./meeting-tools-panel.module.css";

type ToolTab = "search" | "bookmarks" | "speakers" | "timeline";

interface MeetingToolsPanelProps {
  meetingId: string;
  bookmarks: Bookmark[];
  timeline: TimelineMarker[];
  speakers: Speaker[];
  playerAvailable: boolean;
  durationMs: number | null;
}

const tabLabels: Record<ToolTab, string> = {
  search: "検索",
  bookmarks: "ブックマーク",
  speakers: "話者名",
  timeline: "タイムライン",
};

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function player(): HTMLMediaElement | null {
  const element = document.querySelector("[data-meeting-media]");
  return element instanceof HTMLMediaElement ? element : null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let message = `処理に失敗しました (${response.status})`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Keep status-based message.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export function MeetingToolsPanel({
  meetingId,
  bookmarks: initialBookmarks,
  timeline,
  speakers: initialSpeakers,
  playerAvailable,
  durationMs,
}: MeetingToolsPanelProps) {
  const [activeTab, setActiveTab] = useState<ToolTab>("search");
  const [bookmarks, setBookmarks] = useState(initialBookmarks);
  const [speakers, setSpeakers] = useState(initialSpeakers);
  const [searchResults, setSearchResults] = useState<TranscriptSearchResult[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const syncSpeaker = (event: Event) => {
      const detail = speakerRenamedDetail(event);
      if (!detail) return;
      setSpeakers((current) => current.map((speaker) => speaker.id === detail.speakerId
        ? { ...speaker, display_name: detail.displayName }
        : speaker));
      setSearchResults((current) => current.map((result) => result.speaker_id === detail.speakerId
        ? { ...result, speaker_name: detail.speakerName }
        : result));
    };
    window.addEventListener(SPEAKER_RENAMED_EVENT, syncSpeaker);
    return () => window.removeEventListener(SPEAKER_RENAMED_EVENT, syncSpeaker);
  }, []);

  function seek(milliseconds: number) {
    const media = player();
    if (!media) return;
    window.dispatchEvent(new Event("speak-note:open-transcript"));
    media.currentTime = milliseconds / 1000;
    void media.play();
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const query = String(data.get("query") ?? "").trim();
    const speakerId = String(data.get("speaker_id") ?? "");
    if (!query) return;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: query });
      if (speakerId) params.set("speaker_id", speakerId);
      setSearchResults(await api(`/meetings/${meetingId}/search?${params}`));
      setMessage("検索結果を更新しました");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "検索できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function addBookmark(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    if (!title) return;
    setBusy(true);
    setError("");
    try {
      const bookmark = await api<Bookmark>(`/meetings/${meetingId}/bookmarks`, {
        method: "POST",
        body: JSON.stringify({
          timestamp_ms: Math.round((player()?.currentTime ?? 0) * 1000),
          title,
          note: String(data.get("note") ?? "").trim() || null,
        }),
      });
      setBookmarks((current) =>
        [...current, bookmark].sort((a, b) => a.timestamp_ms - b.timestamp_ms),
      );
      form.reset();
      setMessage("現在の再生位置へ追加しました");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bookmarkを追加できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function removeBookmark(bookmarkId: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/meetings/${meetingId}/bookmarks/${bookmarkId}`, { method: "DELETE" });
      setBookmarks((current) => current.filter((bookmark) => bookmark.id !== bookmarkId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bookmarkを削除できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function saveSpeaker(event: FormEvent<HTMLFormElement>, speakerId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const displayName = String(data.get("display_name") ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const speaker = await api<Speaker>(
        `/meetings/${meetingId}/speakers/${speakerId}`,
        { method: "PATCH", body: JSON.stringify({ display_name: displayName || null }) },
      );
      setSpeakers((current) =>
        current.map((value) => value.id === speaker.id ? speaker : value),
      );
      dispatchSpeakerRenamed({
        speakerId: speaker.id,
        displayName: speaker.display_name,
        speakerName: speaker.display_name ?? speaker.internal_name,
      });
      setMessage("話者名を保存し、文字起こしと字幕へ反映しました");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "話者名を保存できませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className={styles.panel} aria-label="会議ツール">
      <h2 className={styles.visuallyHidden}>会議ツール</h2>
      <div className={styles.tabs} role="tablist" aria-label="会議ツールの切り替え">
        {(Object.keys(tabLabels) as ToolTab[]).map((tab) => (
          <button
            type="button"
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            className={activeTab === tab ? styles.activeTab : ""}
            onClick={() => { setActiveTab(tab); setMessage(""); setError(""); }}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </div>

      {(message || error) && (
        <p className={error ? styles.error : styles.message} role="status">
          {error || message}
        </p>
      )}

      {activeTab === "search" && (
        <section className={styles.tool}>
          <h3>文字起こしを検索</h3>
          <form onSubmit={search}>
            <input name="query" placeholder="キーワードを入力" required maxLength={200} />
            <select name="speaker_id" aria-label="話者フィルター">
              <option value="">すべての話者</option>
              {speakers.map((speaker) => (
                <option key={speaker.id} value={speaker.id}>
                  {speaker.display_name ?? speaker.internal_name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy}>検索</button>
          </form>
          <div className={styles.results}>
            {searchResults.length === 0 && <p>検索結果はここに表示されます。</p>}
            {searchResults.map((result) => (
              <button key={result.segment_id} type="button" onClick={() => seek(result.start_ms)}>
                <strong><Play size={12} aria-hidden="true" /> {formatTimestamp(result.start_ms)} {result.speaker_name}</strong>
                <span>{result.text}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {activeTab === "bookmarks" && (
        <section className={`${styles.tool} ${styles.bookmarkTool}`}>
          <h3>ブックマークを現在位置に追加</h3>
          <form onSubmit={addBookmark}>
            <input name="title" placeholder="タイトル" required maxLength={200} />
            <input name="note" placeholder="メモ（任意）" maxLength={5000} />
            <button type="submit" disabled={busy || !playerAvailable}>現在位置に追加</button>
          </form>
          <div className={styles.bookmarks}>
            {bookmarks.length === 0 && <p>ブックマークはまだありません。</p>}
            {bookmarks.map((bookmark) => (
              <article key={bookmark.id}>
                <button type="button" onClick={() => seek(bookmark.timestamp_ms)}>
                  <Play size={12} aria-hidden="true" /> {formatTimestamp(bookmark.timestamp_ms)} {bookmark.title}
                </button>
                <button type="button" onClick={() => void removeBookmark(bookmark.id)}>削除</button>
                {bookmark.note && <p>{bookmark.note}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      {activeTab === "speakers" && (
        <section className={styles.tool}>
          <h3>話者名</h3>
          <div className={styles.speakers}>
            {speakers.length === 0 && <p>話者情報はまだありません。</p>}
            {speakers.map((speaker) => (
              <form
                key={speaker.id + ":" + (speaker.display_name ?? "")}
                onSubmit={(event) => void saveSpeaker(event, speaker.id)}
              >
                <label htmlFor={`tool-speaker-${speaker.id}`}>{speaker.internal_name}</label>
                <input
                  id={`tool-speaker-${speaker.id}`}
                  name="display_name"
                  defaultValue={speaker.display_name ?? ""}
                  maxLength={200}
                  placeholder="表示名"
                />
                <button type="submit" disabled={busy}>保存</button>
              </form>
            ))}
          </div>
        </section>
      )}

      {activeTab === "timeline" && (
        <section className={styles.tool}>
          <h3>タイムライン</h3>
          {timeline.length === 0 ? (
            <p className={styles.muted}>マーカーはまだありません。</p>
          ) : (
            <>
              {durationMs && durationMs > 0 && (
                <div className={styles.timelineRail} aria-label="会議タイムラインマーカー">
                  {timeline.map((marker) => (
                    <button
                      key={`rail-${marker.kind}-${marker.id}`}
                      type="button"
                      style={{ left: `${Math.min(100, marker.timestamp_ms / durationMs * 100)}%` }}
                      onClick={() => seek(marker.timestamp_ms)}
                      title={`${formatTimestamp(marker.timestamp_ms)} ${marker.title}`}
                      aria-label={`${formatTimestamp(marker.timestamp_ms)} ${marker.title}`}
                    />
                  ))}
                </div>
              )}
              <div className={styles.timeline}>
                {timeline.map((marker) => (
                  <button
                    key={`${marker.kind}-${marker.id}`}
                    type="button"
                    onClick={() => seek(marker.timestamp_ms)}
                  >
                    <span>{marker.kind}</span>
                    <strong>{formatTimestamp(marker.timestamp_ms)} {marker.title}</strong>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </aside>
  );
}
