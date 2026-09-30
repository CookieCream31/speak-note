"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { knowledgeApi, meetingsApi, type Meeting, type PersonalProfile, type Project, type ProjectDocument } from "@/lib/api";
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

  return <main className={styles.shell}>
    <header className={styles.header}>
      <div><Link href="/" className={styles.back}>← ホーム</Link><span className={styles.eyebrow}>KNOWLEDGE WORKSPACE</span><h1>プロジェクト</h1>
        <p>親プロジェクトと子プロジェクトで情報を整理します。子は親の情報を引き継ぎ、他の子の資料は参照しません。</p></div>
      <ThemeSelector />
    </header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.grid}>
      <aside className={styles.panel}>
        <div className={styles.panelTitle}><h2>プロジェクト一覧</h2><button type="button" disabled={busy} onClick={() => selectProject(null)}>＋ 新規</button></div>
        {projects.filter((project) => !project.parent_id).map((project) => <div key={project.id}>
          <button type="button" disabled={busy} className={`${styles.projectItem} ${selectedId === project.id ? styles.active : ""}`} onClick={() => selectProject(project)}>{project.name}</button>
          {projects.filter((child) => child.parent_id === project.id).map((child) =>
            <button key={child.id} type="button" disabled={busy} className={`${styles.projectItem} ${styles.child} ${selectedId === child.id ? styles.active : ""}`} onClick={() => selectProject(child)}>↳ {child.name}</button>)}
        </div>)}
        {projects.length === 0 && <p className={styles.muted}>まだプロジェクトがありません。</p>}
        <div className={styles.divider} />
        <div className={styles.panelTitle}><h2>共通プロフィール</h2><button type="button" disabled={busy} onClick={() => selectProfile(null)}>＋ 新規</button></div>
        {profiles.map((profile) => <button key={profile.id} type="button" disabled={busy} className={`${styles.projectItem} ${profileId === profile.id ? styles.active : ""}`} onClick={() => selectProfile(profile)}>{profile.name}</button>)}
      </aside>
      <div className={styles.stack}>
        <section className={styles.panel}>
          <span className={styles.eyebrow}>{selected ? "EDIT PROJECT" : "NEW PROJECT"}</span>
          <h2>{selected ? selected.name : "プロジェクトを作成"}</h2>
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
            <label>背景・会社情報<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={30000} rows={5} placeholder="応募先、目的、前提など" /></label>
            <button className={styles.primary} disabled={busy}>保存</button>
          </form>
        </section>
        {selected && <section className={styles.panel}>
          <span className={styles.eyebrow}>PROJECT KNOWLEDGE</span><h2>資料</h2>
          <p className={styles.muted}>このプロジェクトの資料です。親の資料も子で利用できます。除外した資料は回答支援の参照対象になりません。</p>
          {documents.map((document) => <div key={document.id} className={styles.documentRow}><div><button type="button" disabled={busy} className={styles.documentEdit} onClick={() => { setDocumentId(document.id); setDocumentName(document.name); setDocumentContent(document.content); }}>{document.name}</button><small>v{document.revision} · {document.content.length.toLocaleString()}文字</small></div>
            <label><input type="checkbox" checked={document.included} disabled={busy} onChange={() => void toggleDocument(document)} /> 参照する</label></div>)}
          <form onSubmit={(event) => void addDocument(event)} className={styles.form}>
            <label>資料名<input value={documentName} onChange={(event) => setDocumentName(event.target.value)} maxLength={200} required /></label>
            <label>テキストを読み込む<input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => void readFile(event.target.files?.[0])} /></label>
            <label>本文<textarea value={documentContent} onChange={(event) => setDocumentContent(event.target.value)} rows={5} maxLength={100000} required /></label>
            <div className={styles.documentActions}><button disabled={busy}>{documentId ? "変更を保存" : "資料を追加"}</button>{documentId && <button type="button" disabled={busy} onClick={() => { setDocumentId(null); setDocumentName(""); setDocumentContent(""); }}>キャンセル</button>}</div>
          </form>
        </section>}
        <section className={styles.panel}>
          <span className={styles.eyebrow}>SHARED PROFILE</span><h2>{profileId ? "プロフィールを編集" : "共通プロフィールを作成"}</h2>
          <p className={styles.muted}>AIモデル設定とは別の、経歴・スキル・自己紹介などの事実です。プロジェクトごとに利用するプロフィールを選びます。</p>
          <form onSubmit={(event) => void saveProfile(event)} className={styles.form}>
            <label>名前<input value={profileName} onChange={(event) => setProfileName(event.target.value)} required maxLength={100} placeholder="例：自分の経歴" /></label>
            <label>内容<textarea value={profileBody} onChange={(event) => setProfileBody(event.target.value)} rows={5} maxLength={30000} placeholder="職務経歴、経験、実績など" /></label>
            <button disabled={busy}>保存</button>
          </form>
        </section>
        {selected && <section className={styles.panel}><span className={styles.eyebrow}>MEETINGS</span><div className={styles.panelTitle}><h2>このプロジェクトの会議</h2><Link href={`/?create=1&project_id=${selected.id}`}>＋ 会議を作成</Link></div>
          {projectMeetings.length === 0 ? <p className={styles.muted}>会議はまだありません。ホームから会議を作成し、プロジェクトを選択してください。</p> :
            projectMeetings.map((meeting) => <Link key={meeting.id} className={styles.meetingLink} href={`/meetings/${meeting.id}`}>{meeting.title} <span>→</span></Link>)}
        </section>}
      </div>
    </div>
  </main>;
}
