// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerAssistApi, type AssistSession, type LiveAnswer } from "@/lib/answer-assist";
import { AnswerAssistPanel } from "./answer-assist-panel";

vi.mock("@/lib/answer-assist", async (original) => {
  const actual = await original<typeof import("@/lib/answer-assist")>();
  return { ...actual, answerAssistApi: {
    profiles: vi.fn(), providers: vi.fn(), session: vi.fn(), start: vi.fn(),
    stop: vi.fn(), automatic: vi.fn(), feed: vi.fn(), answers: vi.fn(), generate: vi.fn(),
  } };
});

const configuration = {
  profile_name: "ローカル", provider_name: "Ollama", provider_type: "ollama",
  base_url: "http://localhost:11434", model: "local-model", temperature: 0.2,
};
const session: AssistSession = {
  id: "session", capture_id: "capture", enabled: true, profile_id: "local",
  configuration, knowledge_snapshot: { sources: [] },
};
let container: HTMLDivElement;
let root: Root;

function button(text: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
  if (!found) throw new Error("Missing button: " + text);
  return found;
}
async function render() {
  await act(async () => { root.render(<AnswerAssistPanel meetingId="meeting" />); });
}
async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(answerAssistApi.profiles).mockResolvedValue([
    { id: "local", name: "ローカル", provider_id: "ollama", model: "local-model", temperature: 0.2, is_default: true, created_at: "", updated_at: "" },
    { id: "cloud", name: "クラウド", provider_id: "gemini", model: "gemini-model", temperature: 0.1, is_default: false, created_at: "", updated_at: "" },
  ]);
  vi.mocked(answerAssistApi.providers).mockResolvedValue([
    { id: "ollama", name: "Ollama", provider_type: "ollama", base_url: configuration.base_url, enabled: true, has_api_key: false, api_key_masked: null, created_at: "", updated_at: "" },
    { id: "gemini", name: "Gemini", provider_type: "gemini", base_url: null, enabled: true, has_api_key: true, api_key_masked: "****", created_at: "", updated_at: "" },
  ]);
  vi.mocked(answerAssistApi.session).mockResolvedValue(null);
  vi.mocked(answerAssistApi.feed).mockResolvedValue({ capture_id: "capture", segments: [] });
  vi.mocked(answerAssistApi.answers).mockResolvedValue([]);
  vi.mocked(answerAssistApi.start).mockResolvedValue(session);
  vi.mocked(answerAssistApi.stop).mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("answer assistance profile selection", () => {
  it("requires consent and keeps automatic generation off", async () => {
    await render();
    expect(button("このAIで開始").disabled).toBe(true);
    const consent = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(consent);
    await click(button("このAIで開始"));
    expect(answerAssistApi.start).toHaveBeenCalledWith("meeting", "local");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(answerAssistApi.generate).not.toHaveBeenCalled();
  });
  it("stops the old AI before changing profile and requires fresh consent", async () => {
    vi.mocked(answerAssistApi.session).mockResolvedValue(session);
    await render();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "cloud";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(answerAssistApi.stop).toHaveBeenCalledWith("meeting", "session");
    expect(select.value).toBe("cloud");
    expect(button("このAIで開始").disabled).toBe(true);
    expect(container.textContent).toContain("Gemini：外部送信");
    expect(answerAssistApi.start).not.toHaveBeenCalled();
  });
  it("keeps the previous completed answer visible while a new answer is generating", async () => {
    vi.mocked(answerAssistApi.session).mockResolvedValue(session);
    const old: LiveAnswer = {
      id: "old", session_id: session.id, sequence: 1, question: "前の質問", status: "completed",
      short_answer: "前の回答", detailed_answer: "詳細", source_ids: [], insufficient_information: true,
      input_snapshot: { sources: [], configuration }, error_message: null, created_at: "",
    };
    vi.mocked(answerAssistApi.answers).mockResolvedValue([
      { ...old, id: "new", sequence: 2, status: "processing", short_answer: null }, old,
    ]);
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("回答を生成しています");
    expect(container.textContent).toContain("前の回答");
    expect(container.textContent).toContain("回答案 · 未発言");
  });
  it("switches AI conversation monitoring ON and OFF during a meeting", async () => {
    vi.mocked(answerAssistApi.session).mockResolvedValue(session);
    const enabled = { ...session, configuration: { ...configuration, automatic: { enabled: true, target_speaker: null, revision: "on" } } };
    vi.mocked(answerAssistApi.automatic).mockResolvedValueOnce(enabled).mockResolvedValueOnce({
      ...session, configuration: { ...configuration, automatic: { enabled: false, target_speaker: null, revision: "off" } },
    });
    await render();
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(toggle);
    expect(answerAssistApi.automatic).toHaveBeenNthCalledWith(1, "meeting", "session", true, "");
    expect(toggle.checked).toBe(true);
    expect(container.textContent).toContain("自動回答ON");
    await click(toggle);
    expect(answerAssistApi.automatic).toHaveBeenNthCalledWith(2, "meeting", "session", false, "");
    expect(toggle.checked).toBe(false);
    expect(answerAssistApi.generate).not.toHaveBeenCalled();
  });
  it("keeps ON when stopping the server monitor fails", async () => {
    vi.mocked(answerAssistApi.session).mockResolvedValue({
      ...session, configuration: { ...configuration, automatic: { enabled: true, target_speaker: null, revision: "on" } },
    });
    vi.mocked(answerAssistApi.automatic).mockRejectedValue(new Error("停止できません"));
    await render();
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(toggle);
    expect(toggle.checked).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("停止できません");
  });

});
