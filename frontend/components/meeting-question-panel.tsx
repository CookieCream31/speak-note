"use client";

import { Sparkles } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import type { MeetingQuestion } from "@/lib/api";

import styles from "./meeting-question-panel.module.css";

interface MeetingQuestionPanelProps {
  meetingId: string;
  initialQuestions: MeetingQuestion[];
  available: boolean;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: string };
    if (body.detail) return body.detail;
  } catch {
    // Use the status-based message for a non-JSON response.
  }
  return `処理に失敗しました (${response.status})`;
}

export function MeetingQuestionPanel({
  meetingId,
  initialQuestions,
  available,
}: MeetingQuestionPanelProps) {
  const [questions, setQuestions] = useState(initialQuestions);
  const [questionText, setQuestionText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const conversationRef = useRef<HTMLDivElement>(null);
  const pending = questions.some(
    (question) => question.status === "queued" || question.status === "processing",
  );
  const latestQuestion = questions.at(-1);
  const latestQuestionState = latestQuestion
    ? [
        latestQuestion.id,
        latestQuestion.status,
        latestQuestion.answer ?? "",
        latestQuestion.error_message ?? "",
      ].join(":")
    : "empty";

  const refreshQuestions = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/meetings/${meetingId}/questions`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setQuestions(await response.json() as MeetingQuestion[]);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "回答を更新できませんでした");
    }
  }, [meetingId]);

  useEffect(() => {
    if (!pending) return;
    const intervalId = window.setInterval(() => void refreshQuestions(), 2000);
    return () => window.clearInterval(intervalId);
  }, [pending, refreshQuestions]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    conversation.scrollTo({
      top: conversation.scrollHeight,
      behavior: "smooth",
    });
  }, [latestQuestionState]);

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = questionText.trim();
    if (!normalized || submitting || pending || !available) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/meetings/${meetingId}/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: normalized }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const created = await response.json() as MeetingQuestion;
      setQuestions((current) => [...current, created]);
      setQuestionText("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "質問を送信できませんでした");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryQuestion(question: MeetingQuestion) {
    if (!question.job_id || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/jobs/${question.job_id}/retry`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setQuestions((current) => current.map((item) => (
        item.id === question.id
          ? { ...item, status: "queued", error_message: null, completed_at: null }
          : item
      )));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "回答を再試行できませんでした");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.panel} aria-label="会議内容への質問">
      <header className={styles.header}>
        <h3 className={styles.visuallyHidden}>会議内容について質問</h3>
        <span>確定文字起こしを根拠に回答します</span>
      </header>

      <div ref={conversationRef} className={styles.conversation} aria-live="polite">
        {questions.length === 0 && (
          <div className={styles.empty}>
            <span aria-hidden="true"><Sparkles size={16} /></span>
            <strong>会議の内容を確認できます</strong>
            <p>決定理由、担当者、発言内容などを自然な文章で質問してください。</p>
          </div>
        )}
        {questions.map((question) => (
          <article className={styles.exchange} key={question.id}>
            <div className={styles.userMessage}>
              <span className={styles.visuallyHidden}>あなた</span>
              <p>{question.question}</p>
            </div>
            <div className={styles.answer} data-status={question.status}>
              <div className={styles.answerHeading}>
                <span className={styles.aiMark} aria-hidden="true"><Sparkles size={16} /></span>
                <strong>AI回答</strong>
                <small>· {question.model}</small>
              </div>
              {(question.status === "queued" || question.status === "processing") && (
                <p className={styles.processing}>
                  <i aria-hidden="true" />
                  {question.status === "queued" ? "回答の開始を待っています" : "文字起こしを確認しています"}
                </p>
              )}
              {question.status === "completed" && (
                <>
                  {question.insufficient_information && (
                    <span className={styles.unsupported}>文字起こし内に十分な情報がありません</span>
                  )}
                  <p className={styles.answerText}>{question.answer}</p>
                </>
              )}
              {question.status === "failed" && (
                <div className={styles.failed}>
                  <p>{question.error_message ?? "回答を作成できませんでした"}</p>
                  <button
                    type="button"
                    disabled={submitting || !question.job_id}
                    onClick={() => void retryQuestion(question)}
                  >
                    再試行
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      <form className={styles.composer} onSubmit={(event) => void submitQuestion(event)}>
        <textarea
          value={questionText}
          onChange={(event) => setQuestionText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter"
              || event.shiftKey
              || event.nativeEvent.isComposing
            ) {
              return;
            }
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          placeholder={
            available
              ? "例：この方針に決まった理由は？"
              : "確定文字起こしの完了後に質問できます"
          }
          rows={3}
          maxLength={2000}
          disabled={!available || pending || submitting}
          aria-label="会議内容への質問"
        />
        <div>
          <small>{questionText.length}/2000 · Enterで送信 / Shift+Enterで改行</small>
          <button
            type="submit"
            disabled={!available || pending || submitting || !questionText.trim()}
          >
            {submitting ? "送信中…" : pending ? "回答中…" : "質問する"}
          </button>
        </div>
      </form>
    </section>
  );
}
