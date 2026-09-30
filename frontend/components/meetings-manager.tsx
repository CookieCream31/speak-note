"use client";

import {
  AudioLines, Folder, Hash, House, Inbox, List, Mic, MonitorUp, Search, SearchX, Sparkles, Star, StarOff, Upload, Video,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  bulkManageMeetingsAction,
  createMeetingTagAction,
  deleteMeetingAction,
  deleteMeetingTagAction,
  updateMeetingFavoriteAction,
  updateMeetingTitleAction,
} from "@/app/actions";
import {
  meetingsApi,
  type AIProfile,
  type Meeting,
  type MeetingSourceType,
  type MeetingSummaryFormat,
  type MeetingTag,
  type MeetingTemplate,
  type Project,
} from "@/lib/api";
import {
  detectDisplayCaptureSupport,
  displayCaptureSupportMessage,
  type DisplayCaptureSupport,
} from "@/lib/display-capture";
import { formatDate, sourceLabels, statusLabels } from "@/lib/format";
import { stagePendingLiveCapture } from "@/lib/pending-live-capture";

import {
  uploadMediaFile,
  type UploadSession,
} from "./chunked-media-uploader";
import styles from "./meetings-manager.module.css";
import { ThemeSelector } from "./theme-selector";
import { MicrophoneStartToggle } from "./microphone-start-toggle";
import { NewMeetingProjectField } from "./new-meeting-project-field";

interface SourceOption {
  value: MeetingSourceType;
  label: string;
  description: string;
}

const sourceOptions: SourceOption[] = [
  {
    value: "media_upload",
    label: "音声・動画をアップロード",
    description: "mp4・mov・webm・m4a・mp3・wav・flac",
  },
  {
    value: "live",
    label: "画面共有を録画",
    description: "画面とマイクを記録",
  },
  {
    value: "audio_recording",
    label: "マイク音声を録音",
    description: "画面共有なしで音声を記録",
  },
];

type SortMode = "newest" | "oldest" | "title";
type RecordView = "all" | "favorites";
type BulkAction = "favorite" | "unfavorite" | "tag" | "untag" | "delete";

interface MeetingsManagerProps {
  meetings: Meeting[];
  tags: MeetingTag[];
  aiProfiles: AIProfile[];
  templates?: MeetingTemplate[];
  projects?: Project[];
  templateLoadError?: string;
  aiProfileLoadError?: string;
  loadError?: string;
  tagLoadError?: string;
  initialCreateOpen?: boolean;
  initialProjectId?: string | null;
}

const activeStatuses = new Set([
  "recording",
  "uploading",
  "preprocessing",
  "queued",
  "transcribing",
  "analyzing",
]);

function formatDuration(milliseconds: number | null): string {
  if (!milliseconds) return "--:--";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function SourceIcon({ sourceType, size = 18 }: { sourceType: MeetingSourceType; size?: number }) {
  switch (sourceType) {
    case "media_upload": return <Upload size={size} />;
    case "live": return <MonitorUp size={size} />;
    case "video_upload": return <Video size={size} />;
    case "audio_upload": return <AudioLines size={size} />;
    default: return <Mic size={size} />;
  }
}

function meetingStatusLabel(meeting: Meeting): string {
  return meeting.source_type === "audio_recording" && meeting.status === "recording"
    ? "録音中"
    : statusLabels[meeting.status];
}

export function MeetingsManager({
  meetings,
  tags,
  aiProfiles,
  templates = [],
  projects = [],
  templateLoadError,
  aiProfileLoadError,
  loadError,
  tagLoadError,
  initialCreateOpen = false,
  initialProjectId = null,
}: MeetingsManagerProps) {
  const router = useRouter();
  const [createdProjects, setCreatedProjects] = useState<Project[]>([]);
  const [projectCreating, setProjectCreating] = useState(false);
  const projectOptions = [...projects, ...createdProjects.filter((created) => !projects.some((project) => project.id === created.id))];
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [recordView, setRecordView] = useState<RecordView>("all");
  const [tagFilter, setTagFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [managing, setManaging] = useState(false);
  const [managementError, setManagementError] = useState("");
  const [bulkTagId, setBulkTagId] = useState("");
  const [createOpen, setCreateOpen] = useState(initialCreateOpen);
  const [createSource, setCreateSource] = useState<MeetingSourceType>("media_upload");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createFile, setCreateFile] = useState<File | null>(null);
  const [createProgress, setCreateProgress] = useState(0);
  const [createStatus, setCreateStatus] = useState("");
  const [createUploadSession, setCreateUploadSession] = useState<UploadSession | null>(null);
  const [pendingMeetingId, setPendingMeetingId] = useState<string | null>(null);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [selectedAIProfile, setSelectedAIProfile] = useState("default");
  const [includeMicrophone, setIncludeMicrophone] = useState(false);
  const [displayLabel, setDisplayLabel] = useState("");
  const [displayCaptureSupport, setDisplayCaptureSupport] =
    useState<DisplayCaptureSupport | null>(null);
  const [selectingDisplay, setSelectingDisplay] = useState(false);
  const preparedDisplayRef = useRef<MediaStream | null>(null);
  const preparedAudioContextRef = useRef<AudioContext | null>(null);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [tagName, setTagName] = useState("");
  const [tagManaging, setTagManaging] = useState(false);
  const [tagError, setTagError] = useState("");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setDisplayCaptureSupport(detectDisplayCaptureSupport());
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => () => {
    for (const track of preparedDisplayRef.current?.getTracks() ?? []) track.stop();
    if (preparedAudioContextRef.current?.state !== "closed") {
      void preparedAudioContextRef.current?.close();
    }
  }, []);

  useEffect(() => {
    const closeMenusOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      document.querySelectorAll<HTMLDetailsElement>(
        "details[data-record-menu][open]",
      ).forEach((menu) => {
        if (!menu.contains(target)) menu.open = false;
      });
    };
    const closeMenusWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      document.querySelectorAll<HTMLDetailsElement>(
        "details[data-record-menu][open]",
      ).forEach((menu) => {
        menu.open = false;
        menu.querySelector<HTMLElement>("summary")?.focus();
      });
    };
    document.addEventListener("pointerdown", closeMenusOutside);
    document.addEventListener("keydown", closeMenusWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenusOutside);
      document.removeEventListener("keydown", closeMenusWithEscape);
    };
  }, []);

  useEffect(() => {
    if (!creating || createSource !== "media_upload") return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [createSource, creating]);

  const completedCount = meetings.filter((meeting) => meeting.status === "completed").length;
  const activeCount = meetings.filter((meeting) => activeStatuses.has(meeting.status)).length;
  const failedCount = meetings.filter((meeting) => meeting.status === "failed").length;
  const favoriteCount = meetings.filter((meeting) => meeting.is_favorite).length;
  const availableIds = new Set(meetings.map((meeting) => meeting.id));
  const selectedMeetingIds = [...selectedIds].filter((meetingId) => availableIds.has(meetingId));

  const visibleMeetings = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("ja");
    const viewMeetings = recordView === "favorites"
      ? meetings.filter((meeting) => meeting.is_favorite)
      : meetings;
    const taggedMeetings = tagFilter
      ? viewMeetings.filter((meeting) => meeting.tags.some((tag) => tag.id === tagFilter))
      : viewMeetings;
    const filtered = normalizedQuery
      ? taggedMeetings.filter((meeting) => {
          const searchable = [
            meeting.title,
            sourceLabels[meeting.source_type],
            meetingStatusLabel(meeting),
            ...meeting.tags.map((tag) => tag.name),
          ].join(" ").toLocaleLowerCase("ja");
          return searchable.includes(normalizedQuery);
        })
      : [...taggedMeetings];
    return filtered.sort((left, right) => {
      if (sortMode === "title") return left.title.localeCompare(right.title, "ja");
      const difference = Date.parse(left.created_at) - Date.parse(right.created_at);
      return sortMode === "oldest" ? difference : -difference;
    });
  }, [meetings, query, recordView, sortMode, tagFilter]);

  const visibleMeetingIds = visibleMeetings.map((meeting) => meeting.id);
  const selectedVisibleCount = visibleMeetingIds.filter((meetingId) => (
    selectedIds.has(meetingId)
  )).length;
  const allVisibleSelected = visibleMeetingIds.length > 0
    && selectedVisibleCount === visibleMeetingIds.length;

  function showRecords(view: RecordView) {
    setRecordView(view);
    window.requestAnimationFrame(() => {
      document.getElementById("records")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function toggleSelection(meetingId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(meetingId)) next.delete(meetingId);
      else next.add(meetingId);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const meetingId of visibleMeetingIds) next.delete(meetingId);
      } else {
        for (const meetingId of visibleMeetingIds) next.add(meetingId);
      }
      return next;
    });
  }

  async function updateFavorite(meeting: Meeting) {
    setManaging(true);
    setManagementError("");
    try {
      await updateMeetingFavoriteAction(meeting.id, !meeting.is_favorite);
      router.refresh();
    } catch (caught) {
      setManagementError(
        caught instanceof Error ? caught.message : "お気に入りを更新できませんでした",
      );
    } finally {
      setManaging(false);
    }
  }

  async function runBulkAction(action: BulkAction, tagId?: string) {
    const meetingIds = selectedMeetingIds;
    if (meetingIds.length === 0 || managing) return;
    if (
      action === "delete"
      && !window.confirm(`選択した${meetingIds.length}件の会議を削除しますか？`)
    ) return;

    setManaging(true);
    setManagementError("");
    try {
      await bulkManageMeetingsAction(action, meetingIds, tagId);
      if (action === "delete") setSelectedIds(new Set());
      router.refresh();
    } catch (caught) {
      setManagementError(
        caught instanceof Error ? caught.message : "一括操作を実行できませんでした",
      );
    } finally {
      setManaging(false);
    }
  }

  async function toggleMeetingTag(meeting: Meeting, tag: MeetingTag) {
    if (managing) return;
    const assigned = meeting.tags.some((existing) => existing.id === tag.id);
    setManaging(true);
    setManagementError("");
    try {
      await bulkManageMeetingsAction(assigned ? "untag" : "tag", [meeting.id], tag.id);
      router.refresh();
    } catch (caught) {
      setManagementError(caught instanceof Error ? caught.message : "タグを更新できませんでした");
    } finally {
      setManaging(false);
    }
  }

  async function createTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tagManaging) return;
    setTagManaging(true);
    setTagError("");
    try {
      await createMeetingTagAction(tagName);
      setTagName("");
      router.refresh();
    } catch (caught) {
      setTagError(caught instanceof Error ? caught.message : "タグを作成できませんでした");
    } finally {
      setTagManaging(false);
    }
  }

  async function deleteTag(tag: MeetingTag) {
    if (tagManaging) return;
    const usedCount = meetings.filter((meeting) => (
      meeting.tags.some((existing) => existing.id === tag.id)
    )).length;
    const message = usedCount > 0
      ? `「${tag.name}」を削除しますか？ ${usedCount}件の会議からも外れます。`
      : `「${tag.name}」を削除しますか？`;
    if (!window.confirm(message)) return;
    setTagManaging(true);
    setTagError("");
    try {
      await deleteMeetingTagAction(tag.id);
      if (tagFilter === tag.id) setTagFilter("");
      if (bulkTagId === tag.id) setBulkTagId("");
      router.refresh();
    } catch (caught) {
      setTagError(caught instanceof Error ? caught.message : "タグを削除できませんでした");
    } finally {
      setTagManaging(false);
    }
  }

  function releasePreparedDisplay() {
    for (const track of preparedDisplayRef.current?.getTracks() ?? []) track.stop();
    preparedDisplayRef.current = null;
    if (preparedAudioContextRef.current?.state !== "closed") {
      void preparedAudioContextRef.current?.close();
    }
    preparedAudioContextRef.current = null;
    setDisplayLabel("");
  }

  function closeCreate() {
    if (creating || selectingDisplay || projectCreating) return;
    releasePreparedDisplay();
    if (pendingMeetingId) {
      router.push("/meetings/" + encodeURIComponent(pendingMeetingId));
      return;
    }
    setCreateOpen(false);
  }

  function openCreate(sourceType: MeetingSourceType) {
    setIncludeMicrophone(false);
    releasePreparedDisplay();
    if (sourceType === "live") {
      setDisplayCaptureSupport(detectDisplayCaptureSupport());
    }
    setCreateSource(sourceType);
    setCreateFile(null);
    setCreateProgress(0);
    setCreateStatus("");
    setCreateUploadSession(null);
    setPendingMeetingId(null);
    setAutoAnalyze(true);
    setSelectedAIProfile("default");
    setCreateError("");
    setCreateOpen(true);
  }

  async function chooseDisplay() {
    if (selectingDisplay || creating) return;
    setSelectingDisplay(true);
    setCreateError("");
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    try {
      const support = detectDisplayCaptureSupport();
      setDisplayCaptureSupport(support);
      if (support !== "supported") {
        throw new Error(displayCaptureSupportMessage(support));
      }
      audioContext = new AudioContext();
      const audioReady = audioContext.state === "suspended"
        ? audioContext.resume()
        : Promise.resolve();
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      await audioReady;
      releasePreparedDisplay();
      preparedDisplayRef.current = stream;
      preparedAudioContextRef.current = audioContext;
      const selectedStream = stream;
      const videoTrack = selectedStream.getVideoTracks()[0];
      setDisplayLabel(videoTrack?.label || "共有画面を選択しました");
      videoTrack?.addEventListener("ended", () => {
        if (preparedDisplayRef.current !== selectedStream) return;
        releasePreparedDisplay();
        setCreateError("共有が終了しました。もう一度共有する画面を選択してください");
      });
      stream = null;
      audioContext = null;
    } catch (caught) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (audioContext?.state !== "closed") void audioContext?.close();
      if (!(caught instanceof DOMException && caught.name === "NotAllowedError")) {
        setCreateError(caught instanceof Error ? caught.message : "共有画面を選択できませんでした");
      }
    } finally {
      setSelectingDisplay(false);
    }
  }

  async function createMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || projectCreating) return;

    const formData = new FormData(event.currentTarget);
    const title = String(formData.get("title") ?? "").trim();
    const sourceType = String(formData.get("source_type") ?? "") as MeetingSourceType;
    const summaryFormatValue = String(formData.get("summary_format") ?? "standard");
    const meetingContext = String(formData.get("meeting_context") ?? "").trim();
    const templateId = String(formData.get("template_id") ?? "") || null;
    const projectId = String(formData.get("project_id") ?? "") || null;
    const requestedAIProfile = selectedAIProfile;
    const summaryFormats: MeetingSummaryFormat[] = ["standard", "concise", "detailed", "bullet"];

    setCreating(true);
    setCreateError("");
    try {
      if (!title || title.length > 200 || !sourceOptions.some(({ value }) => value === sourceType)) {
        throw new Error("タイトルと取り込み方法を確認してください");
      }
      if (templateId && !templates.some((template) => template.id === templateId)) {
        throw new Error("議事録テンプレートを選択し直してください");
      }
      if (!summaryFormats.includes(summaryFormatValue as MeetingSummaryFormat)) {
        throw new Error("要約形式を選択してください");
      }
      if (
        (sourceType === "media_upload" || sourceType === "audio_recording")
        && autoAnalyze
        && requestedAIProfile !== "default"
        && !aiProfiles.some((profile) => profile.id === requestedAIProfile)
      ) {
        throw new Error("要約に使うAIプロファイルを選択してください");
      }
      if (meetingContext.length > 4000) {
        throw new Error("会議の内容は4000文字以内で入力してください");
      }
      if (sourceType === "media_upload" && !createFile) {
        throw new Error("アップロードする音声・動画ファイルを選択してください");
      }
      const displayStream = preparedDisplayRef.current;
      const displayIsLive = displayStream?.getVideoTracks().some(
        (track) => track.readyState === "live",
      );
      if (sourceType === "live" && !displayIsLive) {
        throw new Error("録画する画面またはウィンドウを選択してください");
      }

      const parseSpeakerCount = (name: "min_speakers" | "max_speakers") => {
        const raw = String(formData.get(name) ?? "").trim();
        if (!raw) return null;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error("話者数は1以上の整数で入力してください");
        }
        return value;
      };
      const minSpeakers = parseSpeakerCount("min_speakers");
      const maxSpeakers = parseSpeakerCount("max_speakers");
      if (minSpeakers !== null && maxSpeakers !== null && minSpeakers > maxSpeakers) {
        throw new Error("最小話者数は最大話者数以下にしてください");
      }

      let meetingId = pendingMeetingId;
      if (!meetingId) {
        setCreateStatus("会議を作成しています…");
        const meeting = await meetingsApi.create(title, sourceType, {
          min_speakers: minSpeakers,
          max_speakers: maxSpeakers,
          summary_format: summaryFormatValue as MeetingSummaryFormat,
          meeting_context: meetingContext || null,
          template_id: templateId,
          project_id: projectId,
        });
        meetingId = meeting.id;
        setPendingMeetingId(meetingId);
      } else {
        setCreateStatus("会議設定を更新しています…");
        await meetingsApi.update(meetingId, {
          title,
          min_speakers: minSpeakers,
          max_speakers: maxSpeakers,
          summary_format: summaryFormatValue as MeetingSummaryFormat,
          meeting_context: meetingContext || null,
          project_id: projectId,
        });
      }

      if (sourceType === "media_upload" || sourceType === "audio_recording") {
        setCreateStatus("AI設定を保存しています…");
        await meetingsApi.selectAI(
          meetingId,
          !autoAnalyze
            ? { mode: "none", profile_id: null }
            : requestedAIProfile === "default"
              ? { mode: "default", profile_id: null }
              : { mode: "profile", profile_id: requestedAIProfile },
        );
      }

      if (sourceType === "media_upload" && createFile) {
        setCreateStatus("アップロードを準備しています…");
        await uploadMediaFile(
          meetingId,
          createFile,
          (update) => {
            setCreateProgress(update.progress);
            setCreateStatus(update.statusText);
            setCreateUploadSession(update.session);
          },
          createUploadSession,
        );
        router.push("/meetings/" + encodeURIComponent(meetingId));
        return;
      }

      if (sourceType === "audio_recording") {
        setCreateStatus("録音画面へ移動しています…");
        router.push("/meetings/" + encodeURIComponent(meetingId) + "?start_recording=1&microphone_muted=" + (includeMicrophone ? "0" : "1"));
        return;
      }

      if (!displayStream) {
        throw new Error("共有画面の引き継ぎに失敗しました");
      }
      setCreateStatus("会議画面へ移動しています…");
      stagePendingLiveCapture(
        meetingId,
        displayStream,
        includeMicrophone,
        preparedAudioContextRef.current,
      );
      preparedDisplayRef.current = null;
      preparedAudioContextRef.current = null;
      setDisplayLabel("");
      router.push("/meetings/" + encodeURIComponent(meetingId) + "?start_recording=1");
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "会議を作成できませんでした");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} href="/" aria-label="speak-note ホーム">
          <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
          <span>speak-note</span>
        </Link>
        <nav className={styles.navigation} aria-label="メインナビゲーション">
          <Link className={recordView === "all" ? styles.activeNav : undefined} href="/">
            <span aria-hidden="true"><House size={18} /></span> ホーム
          </Link>
          <button type="button" onClick={() => showRecords("all")}>
            <span aria-hidden="true"><List size={18} /></span> すべての会議
            <small>{meetings.length}</small>
          </button>
          <button
            type="button"
            className={recordView === "favorites" ? styles.activeNav : undefined}
            onClick={() => showRecords("favorites")}
          >
            <span aria-hidden="true"><Star size={18} /></span> お気に入り
            <small>{favoriteCount}</small>
          </button>
          <button type="button" onClick={() => setTagDialogOpen(true)}>
            <span aria-hidden="true"><Hash size={18} /></span> タグ
            <small>{tags.length}</small>
          </button>
          <Link href="/projects">
            <span aria-hidden="true"><Folder size={18} /></span> プロジェクト
          </Link>
          <Link href="/settings/ai">
            <span aria-hidden="true"><Sparkles size={18} /></span> AI設定
          </Link>
        </nav>
        <div className={styles.sidebarStatus}>
          <span>ワークスペース</span>
          <strong>Ubuntu Server</strong>
          <small>Private · speak-note</small>
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <div>
            <h1>ホーム</h1>
          </div>
          <div className={styles.topbarActions}>
            <ThemeSelector />
            <label className={styles.globalSearch}>
              <span aria-hidden="true"><Search size={16} /></span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="会議を検索"
                aria-label="会議を検索"
              />
            </label>
          </div>
        </header>

        <section className={styles.dashboard}>
          <div className={styles.welcome}>
            <div>
              <h2>何を記録しますか？</h2>
              <span>取り込み方法を選ぶと、会議を作成してすぐに開始できます。</span>
            </div>
            <div className={styles.quickActions}>
              {sourceOptions.map((option) => (
                <button type="button" key={option.value} onClick={() => openCreate(option.value)}>
                  <span className={styles.sourceIcon} aria-hidden="true"><SourceIcon sourceType={option.value} /></span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                  <i aria-hidden="true">→</i>
                </button>
              ))}
            </div>
          </div>

          <section className={styles.overview} aria-label="会議の概要">
            <article>
              <span>すべて</span>
              <strong>{meetings.length}</strong>
              <small>会議</small>
            </article>
            <article>
              <span>お気に入り</span>
              <strong>{favoriteCount}</strong>
              <small>登録済み</small>
            </article>
            <article>
              <span>処理中</span>
              <strong>{activeCount}</strong>
              <small>進行中</small>
            </article>
            <article>
              <span>完了</span>
              <strong>{completedCount}</strong>
              <small>確認可能</small>
            </article>
            <article data-alert={failedCount > 0}>
              <span>エラー</span>
              <strong>{failedCount}</strong>
              <small>要確認</small>
            </article>
          </section>

          <section className={styles.records} id="records" aria-labelledby="records-title">
            <header className={styles.recordsHeader}>
              <div>
                <h2 id="records-title">最近の会議</h2>
                <p>
                  {recordView === "favorites"
                    ? `${visibleMeetings.length}件のお気に入り`
                    : query
                      ? `${visibleMeetings.length}件の検索結果`
                      : "作成した会議を開いて確認できます"}
                </p>
              </div>
              <div className={styles.recordsControls}>
                <div className={styles.viewSwitch} role="group" aria-label="会議の表示範囲">
                  <button
                    type="button"
                    aria-pressed={recordView === "all"}
                    onClick={() => setRecordView("all")}
                  >
                    すべて
                  </button>
                  <button
                    type="button"
                    aria-pressed={recordView === "favorites"}
                    onClick={() => setRecordView("favorites")}
                  >
                    <Star size={14} aria-hidden="true" /> お気に入り
                  </button>
                </div>
                <select
                  value={tagFilter}
                  onChange={(event) => setTagFilter(event.target.value)}
                  aria-label="タグで絞り込み"
                >
                  <option value="">すべてのタグ</option>
                  {tags.map((tag) => <option key={tag.id} value={tag.id}># {tag.name}</option>)}
                </select>
                <button
                  className={styles.manageTagsButton}
                  type="button"
                  onClick={() => setTagDialogOpen(true)}
                >
                  タグ管理
                </button>
                <select
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as SortMode)}
                  aria-label="会議の並び順"
                >
                  <option value="newest">新しい順</option>
                  <option value="oldest">古い順</option>
                  <option value="title">タイトル順</option>
                </select>
                <button type="button" onClick={() => openCreate("media_upload")}>＋ 新しい会議</button>
              </div>
            </header>

            {loadError && <div className={styles.errorBanner} role="alert">{loadError}</div>}
            {tagLoadError && <div className={styles.errorBanner} role="alert">{tagLoadError}</div>}
            {managementError && (
              <div className={styles.errorBanner} role="alert">{managementError}</div>
            )}
            {selectedMeetingIds.length > 0 && (
              <div className={styles.bulkToolbar} aria-label="選択した会議の一括操作">
                <strong>{selectedMeetingIds.length}件を選択中</strong>
                <select
                  value={bulkTagId}
                  onChange={(event) => setBulkTagId(event.target.value)}
                  aria-label="一括操作するタグ"
                >
                  <option value="">タグを選択</option>
                  {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                </select>
                <button
                  type="button"
                  disabled={managing || !bulkTagId}
                  onClick={() => void runBulkAction("tag", bulkTagId)}
                >
                  <Hash size={14} aria-hidden="true" /> 追加
                </button>
                <button
                  type="button"
                  disabled={managing || !bulkTagId}
                  onClick={() => void runBulkAction("untag", bulkTagId)}
                >
                  <Hash size={14} aria-hidden="true" /> 解除
                </button>
                <button
                  type="button"
                  disabled={managing}
                  onClick={() => void runBulkAction("favorite")}
                >
                  <Star size={14} aria-hidden="true" /> お気に入り
                </button>
                <button
                  type="button"
                  disabled={managing}
                  onClick={() => void runBulkAction("unfavorite")}
                >
                  <StarOff size={14} aria-hidden="true" /> 解除
                </button>
                <button
                  className={styles.bulkDelete}
                  type="button"
                  disabled={managing}
                  onClick={() => void runBulkAction("delete")}
                >
                  削除
                </button>
                <button
                  className={styles.clearSelection}
                  type="button"
                  disabled={managing}
                  onClick={() => setSelectedIds(new Set())}
                >
                  選択解除
                </button>
              </div>
            )}
            {!loadError && meetings.length === 0 ? (
              <div className={styles.emptyState}>
                <span aria-hidden="true"><Inbox size={32} /></span>
                <h3>最初の会議を作成しましょう</h3>
                <p>上の取り込み方法から音声・動画・画面共有を選択できます。</p>
              </div>
            ) : !loadError && visibleMeetings.length === 0 ? (
              <div className={styles.emptyState}>
                <span aria-hidden="true">{recordView === "favorites" ? <Star size={32} /> : <SearchX size={32} />}</span>
                <h3>
                  {recordView === "favorites" && !query
                    ? "お気に入りの会議はありません"
                    : "一致する会議がありません"}
                </h3>
                <p>
                  {recordView === "favorites" && !query
                    ? "会議行の星を押すと、ここからすぐに開けます。"
                    : "検索キーワードを変更してください。"}
                </p>
              </div>
            ) : (
              <div className={styles.recordList}>
                <div className={styles.listHeading}>
                  <label className={styles.selectionControl}>
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      ref={(input) => {
                        if (input) {
                          input.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
                        }
                      }}
                      onChange={toggleAllVisible}
                      aria-label="表示中の会議をすべて選択"
                    />
                  </label>
                  <span>会議</span><span>作成日時</span><span>長さ</span><span>状態</span>
                  <span>お気に入り</span><span />
                </div>
                {visibleMeetings.map((meeting) => (
                  <article
                    className={styles.record}
                    key={meeting.id}
                    data-selected={selectedIds.has(meeting.id)}
                  >
                    <label className={styles.selectionControl}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(meeting.id)}
                        onChange={() => toggleSelection(meeting.id)}
                        aria-label={`${meeting.title}を選択`}
                      />
                    </label>
                    <Link className={styles.recordMain} href={`/meetings/${meeting.id}`}>
                      <span className={styles.recordIcon} aria-hidden="true">
                        <SourceIcon sourceType={meeting.source_type} />
                      </span>
                      <span>
                        <strong>{meeting.title}</strong>
                        <span className={styles.recordMeta}>
                          <small>{sourceLabels[meeting.source_type]}</small>
                          {meeting.tags.map((tag) => (
                            <span className={styles.tagChip} key={tag.id}># {tag.name}</span>
                          ))}
                        </span>
                      </span>
                    </Link>
                    <time dateTime={meeting.created_at}>{formatDate(meeting.created_at)}</time>
                    <span className={styles.duration}>{formatDuration(meeting.duration_ms)}</span>
                    <span className={styles.status} data-status={meeting.status}>
                      {meetingStatusLabel(meeting)}
                    </span>
                    <button
                      className={styles.favoriteButton}
                      type="button"
                      data-active={meeting.is_favorite}
                      disabled={managing}
                      aria-pressed={meeting.is_favorite}
                      aria-label={
                        meeting.is_favorite
                          ? `${meeting.title}のお気に入りを解除`
                          : `${meeting.title}をお気に入りに追加`
                      }
                      title={meeting.is_favorite ? "お気に入りを解除" : "お気に入りに追加"}
                      onClick={() => void updateFavorite(meeting)}
                    >
                      <span aria-hidden="true"><Star size={16} fill={meeting.is_favorite ? "currentColor" : "none"} /></span>
                    </button>
                    <details
                      className={styles.recordMenu}
                      data-record-menu="true"
                      onToggle={(event) => {
                        if (!event.currentTarget.open) return;
                        document.querySelectorAll<HTMLDetailsElement>(
                          "details[data-record-menu][open]",
                        ).forEach((menu) => {
                          if (menu !== event.currentTarget) menu.open = false;
                        });
                      }}
                    >
                      <summary aria-label={`${meeting.title}の操作`}>•••</summary>
                      <div>
                        <Link href={`/meetings/${meeting.id}`}>会議を開く</Link>
                        <form action={updateMeetingTitleAction}>
                          <input type="hidden" name="meeting_id" value={meeting.id} />
                          <label>タイトル変更</label>
                          <input name="title" defaultValue={meeting.title} maxLength={200} required />
                          <button type="submit">保存</button>
                        </form>
                        <section className={styles.tagAssignments} aria-label="会議のタグ">
                          <strong>タグ</strong>
                          {tags.length > 0 ? (
                            <div>
                              {tags.map((tag) => {
                                const assigned = meeting.tags.some((existing) => existing.id === tag.id);
                                return (
                                  <button
                                    type="button"
                                    key={tag.id}
                                    data-active={assigned}
                                    aria-pressed={assigned}
                                    disabled={managing}
                                    onClick={() => void toggleMeetingTag(meeting, tag)}
                                  >
                                    {assigned ? "✓" : "+"} {tag.name}
                                  </button>
                                );
                              })}
                            </div>
                          ) : <small>タグはまだありません</small>}
                        </section>
                        <form
                          action={deleteMeetingAction}
                          onSubmit={(event) => {
                            if (!window.confirm(`「${meeting.title}」を削除しますか？`)) {
                              event.preventDefault();
                            }
                          }}
                        >
                          <input type="hidden" name="meeting_id" value={meeting.id} />
                          <button className={styles.deleteButton} type="submit">削除</button>
                        </form>
                      </div>
                    </details>
                  </article>
                ))}
              </div>
            )}
          </section>
        </section>
      </div>

      {createOpen && (
        <div
          className={styles.overlay}
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget
              && !creating
              && !selectingDisplay
            ) closeCreate();
          }}
        >
          <section
            className={styles.createDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-meeting-title"
          >
            <header>
              <div>
                <h2 id="create-meeting-title">新しい会議</h2>
              </div>
              <button type="button" disabled={creating || selectingDisplay || projectCreating} onClick={closeCreate}>×</button>
            </header>
            <form onSubmit={createMeeting}>
                <fieldset>
                  <legend>取り込み方法</legend>
                  <div className={styles.sourcePicker}>
                    {sourceOptions.map((option) => (
                    <label key={option.value} data-selected={createSource === option.value}>
                      <input
                        type="radio"
                        name="source_type"
                        value={option.value}
                        checked={createSource === option.value}
                        disabled={creating || Boolean(pendingMeetingId)}
                        onChange={() => {
                          if (option.value !== "live") releasePreparedDisplay();
                          if (option.value !== "media_upload") {
                            setCreateFile(null);
                            setCreateUploadSession(null);
                            setCreateProgress(0);
                          }
                          setCreateStatus("");
                          setCreateError("");
                          setCreateSource(option.value);
                        }}
                      />
                      <span aria-hidden="true"><SourceIcon sourceType={option.value} /></span>
                      <strong>{option.label}</strong>
                    </label>
                  ))}
                  </div>
                </fieldset>
              {createSource === "media_upload" ? (
                <div className={styles.captureSetup}>
                  <label htmlFor="new-meeting-media">音声・動画ファイル</label>
                  <input
                    id="new-meeting-media"
                    type="file"
                    accept=".mp4,.mov,.webm,.m4a,.mp3,.wav,.flac,video/mp4,video/quicktime,video/webm,audio/mp4,audio/mpeg,audio/wav,audio/flac"
                    disabled={creating}
                    required
                    onChange={(event) => {
                      setCreateFile(event.currentTarget.files?.[0] ?? null);
                      setCreateUploadSession(null);
                      setCreateProgress(0);
                      setCreateStatus("");
                      setCreateError("");
                    }}
                  />
                  <p>ファイル形式を自動判定し、大きなファイルは分割してアップロードします。</p>
                </div>
              ) : createSource === "audio_recording" ? (
                <div className={styles.captureSetup}>
                  <div className={styles.microphoneCaptureIntro}>
                    <span aria-hidden="true"><Mic size={20} /></span>
                    <strong>マイク音声のみを録音します</strong>
                    <small>画面共有や映像の保存は行いません。</small>
                  </div>
                  <p>
                    録音開始を押すと会議ページへ移動し、マイクの許可後に録音とリアルタイム文字起こしを開始します。
                  </p>
                </div>
              ) : (
                <div className={styles.captureSetup}>
                  {displayCaptureSupport && displayCaptureSupport !== "supported" ? (
                    <div className={styles.captureCompatibility} role="status">
                      <strong>このブラウザでは画面共有録画を開始できません</strong>
                      <span>{displayCaptureSupportMessage(displayCaptureSupport)}</span>
                      <button type="button" onClick={() => setCreateSource("media_upload")}>
                        ファイル取り込みへ切り替える
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={styles.displaySelectButton}
                        disabled={selectingDisplay || creating || displayCaptureSupport === null}
                        onClick={() => void chooseDisplay()}
                      >
                        {displayCaptureSupport === null
                          ? "対応状況を確認中…"
                          : selectingDisplay
                            ? "共有画面を選択中…"
                            : displayLabel
                              ? "共有する画面を変更"
                              : "共有する画面・ウィンドウを選択"}
                      </button>
                      {displayLabel && <p className={styles.selectedCapture}>✓ {displayLabel}</p>}
                      <p>
                        録画開始を押すと会議ページへ移動し、端末の共有選択画面で選んだ内容を録画します。マイクも含める場合は、話者分離のためヘッドホンの使用を推奨します。
                      </p>
                    </>
                  )}
                </div>
              )}
              {createSource !== "media_upload" && (
                <MicrophoneStartToggle muted={!includeMicrophone} disabled={creating || Boolean(pendingMeetingId)}
                  onChange={(muted) => setIncludeMicrophone(!muted)} />
              )}
              <NewMeetingProjectField
                projects={projectOptions}
                initialProjectId={initialProjectId}
                disabled={creating || Boolean(pendingMeetingId)}
                onCreated={(project) => setCreatedProjects((previous) => [...previous, project])}
                onBusyChange={setProjectCreating}
              />
              <label htmlFor="meeting-template-select">議事録テンプレート</label>
              <select
                id="meeting-template-select"
                name="template_id"
                defaultValue={templates.find((template) => template.is_default)?.id ?? templates[0]?.id ?? ""}
                disabled={creating || Boolean(pendingMeetingId) || templates.length === 0}
                required={templates.length > 0}
              >
                {templates.length === 0 && <option value="">テンプレートなし</option>}
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}{template.is_default ? "（既定）" : ""}
                  </option>
                ))}
              </select>
              {templateLoadError && <p className={styles.inlineWarning}>{templateLoadError}</p>}
              <label htmlFor="dashboard-meeting-title">会議タイトル</label>
              <input
                id="dashboard-meeting-title"
                name="title"
                placeholder="例：プロダクト定例"
                maxLength={200}
                required
              />
              {(createSource === "media_upload" || createSource === "audio_recording") && (
                <fieldset className={styles.summaryPreferences}>
                  <legend>AI要約</legend>
                  <label className={styles.autoAnalyzeOption}>
                    <input
                      type="checkbox"
                      name="auto_analyze"
                      checked={autoAnalyze}
                      disabled={creating}
                      onChange={(event) => setAutoAnalyze(event.currentTarget.checked)}
                    />
                    <span>
                      <strong>文字起こし後にAI要約を自動作成する</strong>
                      <small>オフにすると文字起こしのみ行います。</small>
                    </span>
                  </label>
                  <label>
                    <span>要約に使うAI</span>
                    <select
                      name="ai_profile"
                      value={selectedAIProfile}
                      disabled={!autoAnalyze || creating}
                      onChange={(event) => setSelectedAIProfile(event.currentTarget.value)}
                    >
                      <option value="default">既定のAI設定</option>
                      {aiProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name} — {profile.model}
                        </option>
                      ))}
                    </select>
                  </label>
                  {aiProfileLoadError && (
                    <p className={styles.inlineWarning}>{aiProfileLoadError}</p>
                  )}
                  <label>
                    <span>要約形式</span>
                    <select name="summary_format" defaultValue="standard" disabled={!autoAnalyze || creating}>
                      <option value="standard">標準 — 要点と経緯をバランスよく</option>
                      <option value="concise">簡潔 — 結論を短く</option>
                      <option value="detailed">詳細 — 経緯や条件も残す</option>
                      <option value="bullet">箇条書き — 要点を一覧化</option>
                    </select>
                  </label>
                  <label>
                    <span>会議の背景・内容</span>
                    <textarea
                      name="meeting_context"
                      disabled={!autoAnalyze || creating}
                      maxLength={4000}
                      rows={4}
                      placeholder="例：採用面接。候補者はバックエンドエンジニア。専門用語や参加者名、会議の目的などを書くと理解の補助になります。"
                    />
                  </label>
                  <p>
                    ここに書いた内容は用語や目的を理解する補助として使います。
                    決定事項などの事実は文字起こしを根拠に生成します。
                  </p>
                </fieldset>
              )}
              <fieldset className={styles.speakerBounds}>
                <legend>話者数（任意）</legend>
                <div>
                  <label>
                    <span>最小</span>
                    <input
                      type="number"
                      name="min_speakers"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      placeholder="自動"
                    />
                  </label>
                  <label>
                    <span>最大</span>
                    <input
                      type="number"
                      name="max_speakers"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      placeholder="自動"
                    />
                  </label>
                </div>
                <p>
                  最小は推定する話者数の下限、最大は上限です。空欄なら自動判定。
                  3人に固定する場合は両方に3を入力します。
                </p>
              </fieldset>
              {(creating || createProgress > 0) && createStatus && (
                <div className={styles.createProgress}>
                  <div><span>{createStatus}</span><strong>{createProgress}%</strong></div>
                  <progress max={100} value={createProgress} aria-label="取り込み進捗" />
                </div>
              )}
              {createError && <p className={styles.createError} role="alert">{createError}</p>}
              <div className={styles.dialogActions}>
                <button type="button" disabled={creating || projectCreating} onClick={closeCreate}>
                  {pendingMeetingId ? "会議ページへ移動" : "キャンセル"}
                </button>
                <button
                  type="submit"
                  disabled={
                    creating || projectCreating
                    || (createSource === "media_upload"
                      ? !createFile
                      : createSource === "live"
                        ? !displayLabel || displayCaptureSupport !== "supported"
                        : false)
                  }
                >
                  {creating
                    ? createSource === "media_upload"
                      ? "アップロード中…"
                      : "準備中…"
                    : pendingMeetingId && createSource === "media_upload"
                      ? "アップロードを再試行"
                      : createSource === "media_upload"
                        ? "作成してアップロード"
                        : createSource === "audio_recording"
                          ? "作成して録音開始"
                          : "作成して録画開始"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {tagDialogOpen && (
        <div
          className={styles.overlay}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !tagManaging) setTagDialogOpen(false);
          }}
        >
          <section
            className={`${styles.createDialog} ${styles.tagDialog}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="tag-dialog-title"
          >
            <header>
              <div>
                <h2 id="tag-dialog-title">タグを管理</h2>
              </div>
              <button
                type="button"
                disabled={tagManaging}
                onClick={() => setTagDialogOpen(false)}
              >×</button>
            </header>
            <form className={styles.tagCreateForm} onSubmit={(event) => void createTag(event)}>
              <label htmlFor="new-tag-name">新しいタグ</label>
              <div>
                <input
                  id="new-tag-name"
                  value={tagName}
                  onChange={(event) => setTagName(event.target.value)}
                  placeholder="例：採用、プロジェクトA"
                  maxLength={50}
                  required
                  autoFocus
                />
                <button type="submit" disabled={tagManaging || !tagName.trim()}>作成</button>
              </div>
              {tagError && <p className={styles.createError} role="alert">{tagError}</p>}
            </form>
            <div className={styles.tagList}>
              {tags.length > 0 ? tags.map((tag) => {
                const usedCount = meetings.filter((meeting) => (
                  meeting.tags.some((existing) => existing.id === tag.id)
                )).length;
                return (
                  <div key={tag.id}>
                    <span className={styles.tagChip}># {tag.name}</span>
                    <small>{usedCount}件の会議</small>
                    <button
                      type="button"
                      disabled={tagManaging}
                      aria-label={`${tag.name}タグを削除`}
                      onClick={() => void deleteTag(tag)}
                    >削除</button>
                  </div>
                );
              }) : (
                <p className={styles.noTags}>タグはまだありません。用途や案件ごとに作成できます。</p>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
