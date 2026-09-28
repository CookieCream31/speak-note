// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisApi, type AIProfile, type MeetingTemplate } from "@/lib/api";
import { SummaryRegenerationButton, type SummaryRegenerationProps } from "./final-transcript-button";

vi.mock("@/lib/api", () => ({ analysisApi: { regenerate: vi.fn() } }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const profile = { id: "ai-1", name: "会議AI", model: "model-1" } as AIProfile;
const other = { ...profile, id: "ai-2", name: "別のAI", model: "model-2" };
const template = { id: "template-1", name: "別テンプレート", revision: 4,
  definition: { realtime: [], final: [] } } as unknown as MeetingTemplate;
const props: SummaryRegenerationProps = { meetingId: "meeting-1", ready: true, processing: false,
  profiles: [profile, other], templates: [template], currentProfileId: profile.id,
  currentTemplate: { template_id: "meeting-template", revision: 2, name: "元の設定",
    definition: { realtime: [], final: [] } }, hasFinal: true };
let container: HTMLDivElement;
let root: Root;
function button(text: string) {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
  if (!element) throw new Error(`Button missing: ${text}`);
  return element;
}
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function select(label: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SummaryRegenerationButton {...props} />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("summary regeneration dialog", () => {
  it("works on HTTP pages where randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => { bytes.fill(127); return bytes; } });
    vi.mocked(analysisApi.regenerate).mockResolvedValue({ analysis: null, job_id: "job-1" });
    await click(button("要約を再生成"));
    await click(button("再生成を開始"));
    expect(vi.mocked(analysisApi.regenerate).mock.calls[0][1].request_id)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("defaults to the meeting AI and frozen template and cancels without a request", async () => {
    await click(button("要約を再生成"));
    expect(container.querySelector("dialog")?.open).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="AIプロファイル"]')?.value).toBe(profile.id);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="議事録テンプレート"]')?.value).toBe("");
    expect(container.textContent).toContain("元の設定 · v2");
    expect(container.textContent).toContain("要約だけを生成");
    expect(container.querySelector('[name="summary_format"]')).toBeNull();
    await click(button("キャンセル"));
    expect(container.querySelector("dialog")?.open).toBe(false);
    expect(analysisApi.regenerate).not.toHaveBeenCalled();
  });
  it("submits the chosen AI and template once, shows pending status and refreshes", async () => {
    let resolve!: (value: { analysis: null; job_id: string }) => void;
    vi.mocked(analysisApi.regenerate).mockReturnValue(new Promise((done) => { resolve = done; }));
    await click(button("要約を再生成"));
    await select("AIプロファイル", other.id); await select("議事録テンプレート", template.id);
    await click(button("再生成を開始"));
    expect(button("送信中…").disabled).toBe(true);
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(analysisApi.regenerate).toHaveBeenCalledTimes(1);
    expect(analysisApi.regenerate).toHaveBeenCalledWith("meeting-1", {
      profile_id: other.id, template_id: template.id, template_revision: 4, request_id: expect.any(String),
    });
    await act(async () => resolve({ analysis: null, job_id: "job-1" }));
    expect(container.querySelector("dialog")?.open).toBe(false);
    expect(button("要約を再生成中…").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("閲覧できます");
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("keeps selection and idempotency key on error, and supports retry", async () => {
    vi.mocked(analysisApi.regenerate).mockRejectedValue(new Error("外部APIが利用できません"));
    await click(button("要約を再生成")); await select("議事録テンプレート", template.id);
    await click(button("再生成を開始"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("外部APIが利用できません");
    expect(container.querySelector("dialog")?.open).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="議事録テンプレート"]')?.value).toBe(template.id);
    const firstRequest = vi.mocked(analysisApi.regenerate).mock.calls[0][1];
    vi.mocked(analysisApi.regenerate).mockResolvedValue({ analysis: null, job_id: "job-1" });
    await click(button("再生成を開始"));
    expect(vi.mocked(analysisApi.regenerate).mock.calls[1][1]).toEqual(firstRequest);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("disables regeneration during ongoing processing and keeps saved notes available", async () => {
    await act(async () => root.render(<SummaryRegenerationButton {...props} processing />));
    expect(button("要約を再生成中…").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("閲覧できます");
    await click(button("要約を再生成中…"));
    expect(container.querySelector("dialog")?.open).toBe(false);
    expect(analysisApi.regenerate).not.toHaveBeenCalled();
  });
  it("explains first transcription and requires an explicit AI when the meeting had AI off", async () => {
    await act(async () => root.render(<SummaryRegenerationButton {...props} currentProfileId={null} hasFinal={false} aiDisabled />));
    await click(button("要約を再生成"));
    expect(container.textContent).toContain("初回はWhisperX");
    expect(button("再生成を開始").disabled).toBe(true);
    await select("AIプロファイル", other.id);
    expect(button("再生成を開始").disabled).toBe(false);
  });
});
