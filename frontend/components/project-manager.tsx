"use client";

import { ChevronRight, FileText, Plus, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { knowledgeApi, meetingsApi, type Meeting, type PersonalProfile, type Project, type ProjectDocument } from "@/lib/api";
import { AppSidebar } from "./app-sidebar";
import styles from "./project-manager.module.css";
import { ThemeSelector } from "./theme-selector";

export function ProjectManager() {
  const [profiles, setProfiles] = useState<PersonalProfile[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [parentId, setParentId] = useState("");
  const [projectProfileId, setProjectProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileBody, setProfileBody] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documentName, setDocumentName] = useState("");
  const [documentContent, setDocumentContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // The right-hand side edits either the selected project or a shared profile.
  const [detail, setDetail] = useState<"project" | "profile">("project");
  const [documentFormOpen, setDocumentFormOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [nextProfiles, nextProjects] = await Promise.all([
      knowledgeApi.profiles(), knowledgeApi.projects(),
    ]);
    setProfiles(nextProfiles);
    setProjects(nextProjects);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([knowledgeApi.profiles(), knowledgeApi.projects()]).then(([nextProfiles, nextProjects]) => {
      if (cancelled) return;
      setProfiles(nextProfiles);
      setProjects(nextProjects);
    }).catch((caught) => { if (!cancelled) setError(String(caught)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    // selectProject clears documents and meetings whenever the selection changes.
    if (!selectedId) return;
    let cancelled = false;
    void knowledgeApi.documents(selectedId).then((items) => { if (!cancelled) setDocuments(items); }).catch((caught) => { if (!cancelled) setError(String(caught)); });
    void (async () => {
      const collected: Meeting[] = [];
      for (let offset = 0; !cancelled;) {
        const page = await meetingsApi.list(selectedId, offset);
        collected.push(...page.items);
        offset += page.items.length;
        if (page.items.length === 0 || offset >= page.total) break;
      }
      if (!cancelled) setMeetings(collected);
    })().catch((caught) => { if (!cancelled) setError(String(caught)); });
    return () => { cancelled = true; };
  }, [selectedId]);

  function selectProject(project: Project | null) {
    setSelectedId(project?.id ?? null);
    if ((project?.id ?? null) !== selectedId) { setDocuments([]); setMeetings([]); }
    setDocumentId(null); setDocumentName(""); setDocumentContent("");
    setDocumentFormOpen(false);
    setDetail("project");
    setName(project?.name ?? "");
    setNotes(project?.notes ?? "");
    setParentId(project?.parent_id ?? "");
    setProjectProfileId(project?.profile_id ?? "");
    setError("");
    setNotice("");
  }

  function selectProfile(profile: PersonalProfile | null) {
    setProfileId(profile?.id ?? null);
    setProfileName(profile?.name ?? "");
    setProfileBody(profile?.body ?? "");
    setDetail("profile");
    setError("");
    setNotice("");
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const project = await knowledgeApi.saveProject(selectedId, {
        name: name.trim(), notes: notes.trim(), parent_id: parentId || null,
        profile_id: projectProfileId || null,
      });
      await refresh();
      selectProject(project);
      setNotice("プロジェクトを保存しました");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const profile = await knowledgeApi.saveProfile(profileId, {
        name: profileName.trim(), body: profileBody.trim(),
      });
      await refresh();
      selectProfile(profile);
      setNotice("共通プロフィールを保存しました");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  async function addDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await knowledgeApi.saveDocument(selectedId, documentId, {
        name: documentName.trim(), content: documentContent.trim(),
        included: documents.find((document) => document.id === documentId)?.included ?? true,
      });
      setDocuments(await knowledgeApi.documents(selectedId));
      setDocumentId(null); setDocumentName(""); setDocumentContent("");
      setDocumentFormOpen(false);
      setNotice("資料を保存しました");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  async function toggleDocument(document: ProjectDocument) {
    if (!selectedId) return;
    setBusy(true); setError("");
    try {
      await knowledgeApi.saveDocument(selectedId, document.id, {
        name: document.name, content: document.content, included: !document.included,
      });
      setDocuments(await knowledgeApi.documents(selectedId));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name) || file.size > 100_000) {
      setError("資料は100KB以下の .txt / .md ファイルを選んでください"); return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      setDocumentName(file.name);
      setDocumentContent(content);
    } catch {
      setError("ファイルを読み込めませんでした");
    } finally { setBusy(false); }
  }

  const selected = projects.find((project) => project.id === selectedId);
  const projectMeetings = meetings.filter((meeting) => meeting.project_id === selectedId);

  const parent = selected?.parent_id ? projects.find((project) => project.id === selected.parent_id) : undefined;
  const closeDocumentForm = () => {
    setDocumentId(null); setDocumentName(""); setDocumentContent(""); setDocumentFormOpen(false);
  };

  return <div className={styles.shell}>
    <AppSidebar current="projects" />
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>プロジェクト</h1>
        <ThemeSelector />
        <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => selectProject(null)}>
          <Plus size={16} aria-hidden="true" />新しいプロジェクト
        </button>
      </header>
      <div className={styles.content}>
        <aside className={styles.list}>
          <p className={styles.muted}>親と子の2階層で整理します。子は親の情報を引き継ぎ、兄弟の資料は参照しません。</p>
          <nav className={styles.tree} aria-label="プロジェクト一覧">
            {projects.filter((project) => !project.parent_id).map((project) => <div key={project.id}>
              <button type="button" disabled={busy}
                className={`${styles.projectItem} ${detail === "project" && selectedId === project.id ? styles.active : ""}`}
                aria-current={detail === "project" && selectedId === project.id ? "true" : undefined}
                onClick={() => selectProject(project)}>
                {projects.some((child) => child.parent_id === project.id)
                  ? <ChevronRight size={14} aria-hidden="true" className={styles.expander} />
                  : <span className={styles.expanderSpace} aria-hidden="true" />}
                <span>{project.name}</span>
              </button>
              {projects.filter((child) => child.parent_id === project.id).map((child) =>
                <button key={child.id} type="button" disabled={busy}
                  className={`${styles.projectItem} ${styles.child} ${detail === "project" && selectedId === child.id ? styles.active : ""}`}
                  aria-current={detail === "project" && selectedId === child.id ? "true" : undefined}
                  onClick={() => selectProject(child)}>
                  <span>{child.name}</span>
                </button>)}
            </div>)}
            {projects.length === 0 && <p className={styles.muted}>まだプロジェクトがありません。</p>}
          </nav>
          <div className={styles.divider} />
          <div className={styles.listTitle}>
            <span>共通プロフィール</span>
            <button type="button" disabled={busy} aria-label="共通プロフィールを追加" title="共通プロフィールを追加" onClick={() => selectProfile(null)}>
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
          {profiles.map((profile) => <button key={profile.id} type="button" disabled={busy}
            className={`${styles.projectItem} ${detail === "profile" && profileId === profile.id ? styles.active : ""}`}
            aria-current={detail === "profile" && profileId === profile.id ? "true" : undefined}
            onClick={() => selectProfile(profile)}>
            <UserRound size={16} aria-hidden="true" /><span>{profile.name}</span>
          </button>)}
        </aside>

        <div className={styles.detail}>
          {error && <p className={styles.error} role="alert">{error}</p>}
          {notice && <p className={styles.notice} role="status">{notice}</p>}
          {detail === "profile" ? (
            <section className={styles.card}>
              <h2>{profileId ? "プロフィールを編集" : "共通プロフィールを作成"}</h2>
              <p className={styles.muted}>AIモデル設定とは別の、経歴・スキル・自己紹介などの事実です。プロジェクトごとに利用するプロフィールを選びます。</p>
              <form onSubmit={(event) => void saveProfile(event)} className={styles.form}>
                <label>名前<input value={profileName} onChange={(event) => setProfileName(event.target.value)} required maxLength={100} placeholder="例：自分の経歴" /></label>
                <label>内容<textarea value={profileBody} onChange={(event) => setProfileBody(event.target.value)} rows={8} maxLength={30000} placeholder="職務経歴、経験、実績など" /></label>
                <button className={styles.primary} disabled={busy}>保存</button>
              </form>
            </section>
          ) : <>
            <div className={styles.detailTitle}>
              {parent && <span className={styles.muted}>{parent.name} /</span>}
              <div>
                <h2>{selected ? selected.name : "新しいプロジェクト"}</h2>
                {selected && <Link className={styles.secondaryButton} href={`/?create=1&project_id=${selected.id}`}>
                  <Plus size={16} aria-hidden="true" />この中で会議を作成
                </Link>}
              </div>
            </div>
            <div className={styles.detailGrid}>
              <section className={styles.card}>
                <h3>基本情報</h3>
                <form onSubmit={(event) => void saveProject(event)} className={styles.form}>
                  <label>名前<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="例：就職活動 / A社" /></label>
                  <div className={styles.twoColumns}>
                    <label>親プロジェクト<select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">なし（親として作成）</option>
                      {projects.filter((project) => !project.parent_id && project.id !== selectedId && !projects.some((child) => child.parent_id === selectedId)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select></label>
                    <label>共通プロフィール<select value={projectProfileId} onChange={(event) => setProjectProfileId(event.target.value)}><option value="">{parentId ? "親の設定を引き継ぐ" : "使用しない"}</option>
                      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select></label>
                  </div>
                  <label>背景・会社情報<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={30000} rows={6} placeholder="目的、前提、関係者など" /></label>
                  <button className={styles.primary} disabled={busy}>保存</button>
                </form>
              </section>
              {selected ? <div className={styles.column}>
                <section className={styles.card}>
                  <div className={styles.cardTitle}>
                    <h3>資料</h3>
                    {!documentFormOpen && <button type="button" className={styles.smallButton} disabled={busy} onClick={() => setDocumentFormOpen(true)}>
                      <Plus size={14} aria-hidden="true" />追加
                    </button>}
                  </div>
                  <p className={styles.muted}>.txt / .md（100KBまで）か貼り付けたテキスト。親の資料も利用できます。オフにした資料は回答支援で参照しません。</p>
                  {documents.map((document) => <div key={document.id} className={styles.documentRow}>
                    <FileText size={16} aria-hidden="true" />
                    <div>
                      <button type="button" disabled={busy} className={styles.documentEdit} data-included={document.included}
                        onClick={() => { setDocumentId(document.id); setDocumentName(document.name); setDocumentContent(document.content); setDocumentFormOpen(true); }}>{document.name}</button>
                      <small>v{document.revision} · {document.content.length.toLocaleString()}文字</small>
                    </div>
                    <label className={styles.switchLabel}>
                      <span>{document.included ? "参照する" : "参照しない"}</span>
                      <input type="checkbox" role="switch" checked={document.included} disabled={busy}
                        aria-label={`${document.name}を参照する`} onChange={() => void toggleDocument(document)} />
                    </label>
                  </div>)}
                  {documentFormOpen && <form onSubmit={(event) => void addDocument(event)} className={`${styles.form} ${styles.documentForm}`}>
                    <label>資料名<input value={documentName} onChange={(event) => setDocumentName(event.target.value)} maxLength={200} required /></label>
                    <label>テキストを読み込む<input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => void readFile(event.target.files?.[0])} /></label>
                    <label>本文<textarea value={documentContent} onChange={(event) => setDocumentContent(event.target.value)} rows={5} maxLength={100000} required /></label>
                    <div className={styles.documentActions}>
                      <button type="button" disabled={busy} onClick={closeDocumentForm}>キャンセル</button>
                      <button className={styles.primary} disabled={busy}>{documentId ? "変更を保存" : "資料を追加"}</button>
                    </div>
                  </form>}
                </section>
                <section className={styles.card}>
                  <h3>このプロジェクトの会議</h3>
                  {projectMeetings.length === 0 ? <p className={styles.muted}>会議はまだありません。「この中で会議を作成」から作成できます。</p> :
                    projectMeetings.map((meeting) => <Link key={meeting.id} className={styles.meetingLink} href={`/meetings/${meeting.id}`}>
                      <span>{meeting.title}</span><ChevronRight size={16} aria-hidden="true" />
                    </Link>)}
                </section>
              </div> : <section className={styles.card}>
                <h3>資料と会議</h3>
                <p className={styles.muted}>プロジェクトを保存すると、資料の追加とこのプロジェクトの会議の確認ができます。</p>
              </section>}
            </div>
          </>}
        </div>
      </div>
    </main>
  </div>;
}
