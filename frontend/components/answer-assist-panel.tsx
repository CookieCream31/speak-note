"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { AIProfile, AIProvider } from "@/lib/api";
import {
  answerAssistApi, type AssistFeed, type AssistSession, type LiveAnswer,
} from "@/lib/answer-assist";
import { getLiveTranscriptStore } from "@/lib/live-transcript-store";
import styles from "./answer-assist-panel.module.css";

export function AnswerAssistPanel({ meetingId }: { meetingId: string }) {
  const [profiles, setProfiles] = useState<AIProfile[]>([]);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [profileId, setProfileId] = useState("");
  const [assist, setAssist] = useState<AssistSession | null>(null);
  const [feed, setFeed] = useState<AssistFeed>({ capture_id: null, segments: [] });
  const [answers, setAnswers] = useState<LiveAnswer[]>([]);
  const [question, setQuestion] = useState("");
  const [consent, setConsent] = useState(false);
  const automatic = assist?.configuration.automatic?.enabled ?? false;
  const targetSpeaker = assist?.configuration.automatic?.target_speaker ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answerRevision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([answerAssistApi.profiles(), answerAssistApi.providers(), answerAssistApi.session(meetingId)])
      .then(([nextProfiles, nextProviders, current]) => {
        if (cancelled) return;
        setProfiles(nextProfiles); setProviders(nextProviders); setAssist(current);
        setProfileId(current?.profile_id ?? nextProfiles.find((profile) => profile.is_default)?.id ?? nextProfiles[0]?.id ?? "");
      }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "設定を取得できません"); });
    return () => { cancelled = true; };
  }, [meetingId]);

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      const revision = answerRevision.current;
      try {
        const [nextFeed, history] = await Promise.all([answerAssistApi.feed(meetingId), answerAssistApi.answers(meetingId)]);
        if (cancelled) return;
        setFeed(nextFeed);
        if (revision === answerRevision.current) setAnswers(history);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "回答支援を更新できません");
      } finally { polling = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [meetingId]);

  const active = Boolean(assist?.enabled && feed.capture_id && assist.capture_id === feed.capture_id);
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const selectedProvider = providers.find((provider) => provider.id === selectedProfile?.provider_id);
  const currentAnswers = answers.filter((answer) => answer.session_id === assist?.id && answer.status !== "superseded");
  const latest = currentAnswers[0];
  const displayed = currentAnswers.find((answer) => answer.status === "completed");
  const speakers = useMemo(() => Array.from(new Set(feed.segments.map((segment) => segment.speaker))), [feed]);

  async function start() {
    if (!consent || busy || !profileId) return;
    setBusy(true); setError("");
    try {
      const next = await answerAssistApi.start(meetingId, profileId);
      setAssist(next); setConsent(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "開始できません"); }
    finally { setBusy(false); }
  }

  async function stop(nextProfileId?: string) {
    setBusy(true); setError("");
    try {
      if (assist?.enabled) await answerAssistApi.stop(meetingId, assist.id);
      setAssist(null); setConsent(false);
      if (nextProfileId) setProfileId(nextProfileId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "停止できません"); }
    finally { setBusy(false); }
  }

  async function generate(text: string, brief = false) {
    if (!assist || !active || busy || !text.trim()) return;
    setBusy(true); setError("");
    try {
      const created = await answerAssistApi.generate(meetingId, assist.id, text.trim().slice(0, 2000), brief);
      answerRevision.current += 1;
      setAnswers((previous) => [created, ...previous.filter((answer) => answer.id !== created.id)]);
      setQuestion(text.slice(0, 2000));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "生成できません"); }
    finally { setBusy(false); }
  }

  async function configureAutomatic(enabled: boolean, speaker = targetSpeaker) {
    if (!assist || busy) return;
    setBusy(true); setError("");
    try { setAssist(await answerAssistApi.automatic(meetingId, assist.id, enabled, speaker)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "自動回答を変更できません"); }
    finally { setBusy(false); }
  }

  function answerLatest() {
    const snapshot = getLiveTranscriptStore(meetingId).getSnapshot();
    const text = snapshot.interim?.text ?? snapshot.history.at(-1)?.text ?? feed.segments[0]?.text ?? "";
    if (!text) { setError("回答したい発言を入力してください"); return; }
    void generate(text);
  }

  return <section className={styles.panel}>
    <header className={styles.header}><div><span className={styles.eyebrow}>LIVE ANSWER ASSIST</span><h2>回答支援</h2></div>
      <span className={active ? styles.active : styles.inactive}>{active ? "有効" : "停止中"}</span></header>
    <p className={styles.description}>プロフィール・プロジェクト資料と会話をもとに発言案を作ります。議事録の要約・会議後の質問とは別の機能です。</p>
    <div className={styles.controls}>
      <label>回答に使うAI<select value={profileId} disabled={busy} onChange={(event) => void stop(event.target.value)}>
        {profiles.length === 0 && <option value="">AI設定でプロファイルを作成してください</option>}
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
      </select></label>
      {active ? <button disabled={busy} onClick={() => void stop()}>回答支援を停止</button> : <button className={styles.primary} disabled={busy || !consent || !profileId || !feed.capture_id} onClick={() => void start()}>このAIで開始</button>}
    </div>
    {!active && <label className={styles.consent}><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
      プロフィール・参照資料・直近の会話を {selectedProvider?.name ?? "選択したAI"}（{selectedProvider?.provider_type === "gemini" ? "Gemini：外部送信" : "Ollama：設定された接続先"}）へ送信することを確認しました
    </label>}
    {active && <p className={styles.note}>{assist?.configuration.profile_name} · {assist?.configuration.model} / 開始時の資料 {assist?.knowledge_snapshot.sources.length}件を参照。情報を更新したら開始し直してください。</p>}
    {!feed.capture_id && <p className={styles.note}>録音・画面共有を開始すると回答支援を有効にできます。</p>}
    <div className={styles.autoControls}><label><input type="checkbox" checked={automatic} disabled={!active || busy} onChange={(event) => void configureAutomatic(event.target.checked)} /> 会話をAIで確認して自動回答</label>
      <select aria-label="自動回答の対象話者" value={targetSpeaker} onChange={(event) => void configureAutomatic(automatic, event.target.value)} disabled={!active || busy}>
        <option value="">すべての話者</option>{speakers.map((speaker) => <option key={speaker} value={speaker}>{speaker}</option>)}
      </select></div>
    <p className={styles.note}>混合音声では自分と相手を完全には区別できません。ONの間だけ、新しい発話と直近の会話をAIへ送り、回答が必要な質問か判断します。追加のAI利用料が発生する場合があります。誤検出時はOFFにしてください。</p>
    <textarea aria-label="回答したい質問" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} rows={3} placeholder="回答したい質問を入力、または「今の発言に回答」" />
    <div className={styles.actions}><button disabled={!active || busy} onClick={answerLatest}>今の発言に回答</button><button className={styles.primary} disabled={!active || busy || !question.trim()} onClick={() => void generate(question)}>回答案を生成</button>
      <button disabled={!active || busy || !question.trim()} onClick={() => void generate(question, true)}>短く生成</button></div>
    {automatic && active && <p className={styles.note}>自動回答ON · 会話を継続して確認中</p>}
    {latest?.status === "checking" && <p role="status" className={styles.note}>AIが会話の文脈を確認しています。</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {(latest?.status === "queued" || latest?.status === "processing") && <p role="status" className={styles.note}>回答を生成しています。前の回答は表示したままにします。</p>}
    {latest?.status === "failed" && <p role="alert" className={styles.error}>{latest.error_message}</p>}
    {displayed && <article className={styles.answer}>
      <span className={styles.eyebrow}>回答案 · 未発言</span><p className={styles.question}>{displayed.question}</p>
      {displayed.insufficient_information && <p className={styles.note}>情報不足があります。回答前に内容を確認してください。</p>}
      <p className={styles.answerText}>{displayed.short_answer}</p>
      <details><summary>詳細・根拠を確認</summary><p className={styles.answerText}>{displayed.detailed_answer}</p>
        {displayed.source_ids.map((id) => { const source = displayed.input_snapshot.sources.find((item) => item.id === id); return source ? <div className={styles.source} key={id}><strong>{source.name}</strong><small>{id}</small><p>{source.content}</p></div> : null; })}
      </details>
    </article>}
    <details className={styles.history}><summary>回答履歴（{answers.filter((answer) => answer.short_answer).length}件）</summary>
      {answers.filter((answer) => answer.short_answer).map((answer) => <article className={styles.historyItem} key={answer.id}><small>{answer.input_snapshot.configuration.profile_name} · {answer.input_snapshot.configuration.model}</small><strong>{answer.question}</strong><p>{answer.short_answer}</p></article>)}
    </details>
  </section>;
}
