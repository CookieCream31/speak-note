// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingSummaryDocument } from "./meeting-summary-document";

let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.fn<typeof fetch>();
const dirtyChanged = vi.fn();
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function button(name: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name)!; }
async function click(name: string) { await act(async () => { button(name).click(); }); }
async function input(value: string) {
  await act(async () => {
    const textarea = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(text = "会議概要\n元の本文\n\n決定事項\n担当者を決定", readOnly = false) {
  await act(async () => { root.render(<MeetingSummaryDocument meetingId="meeting" analysisId="summary"
    text={text} revision={3} edited={false} readOnly={readOnly} onDirtyChange={dirtyChanged} />); });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("MeetingSummaryDocument", () => {
  it("edits all sections as one text and preserves whitespace, notes, and revision", async () => {
    fetchMock.mockImplementation(async (_url, init) => response({ content: JSON.parse(String(init?.body)).content, revision: 4, updated_at: "now" }));
    await render(); await click("全文を編集");
    expect(host.querySelector("textarea")?.value).toContain("決定事項");
    const content = "\n自由な見出し\n  追記メモ\n\n決定事項も修正\n";
    await input(content); expect(dirtyChanged).toHaveBeenLastCalledWith(true);
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await click("保存");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/meetings/meeting/analyses/summary/document");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ content, expected_revision: 3 });
    expect(host.querySelector("[data-summary-document]")?.textContent).toBe(content);
    expect(host.textContent).toContain("編集済みの本文");
    expect(dirtyChanged).toHaveBeenLastCalledWith(false);
    await click("全文を編集"); expect(host.querySelector("textarea")?.value).toBe(content);
  });
  it.each([409, 503])("retains drafts when save fails with %s", async (status) => {
    fetchMock.mockResolvedValueOnce(response({ detail: status === 409 ? "別の画面で更新されています" : "保存に失敗しました" }, status))
      .mockResolvedValue(response({ content: "手元のメモ", revision: 4, updated_at: "now" }));
    await render(); await click("全文を編集"); await input("手元のメモ"); await click("保存");
    expect(host.querySelector("textarea")?.value).toBe("手元のメモ");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(status === 409 ? "別の画面" : "保存に失敗");
    await click("保存"); expect(host.querySelector("[data-summary-document]")?.textContent).toBe("手元のメモ");
  });
  it("blocks duplicate saves and shows a pending state", async () => {
    let finish!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render(); await click("全文を編集"); await input("新しい本文");
    await act(async () => { const form = host.querySelector("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(button("保存中…").disabled).toBe(true);
    expect(host.querySelector("textarea")?.disabled).toBe(true);
    await act(async () => { finish(response({ content: "新しい本文", revision: 4, updated_at: "now" })); });
    expect(host.textContent).toContain("本文を保存しました");
  });
  it("confirms discarding changes and restores the saved text", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await render(); await click("全文を編集"); const original = host.querySelector("textarea")!.value;
    await input("未保存のメモ"); await click("キャンセル");
    expect(host.querySelector("textarea")?.value).toBe("未保存のメモ");
    await click("キャンセル"); expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector("[data-summary-document]")?.textContent).toBe(original);
    expect(confirm).toHaveBeenCalledTimes(2); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("allows saving an empty document", async () => {
    fetchMock.mockResolvedValue(response({ content: "", revision: 4, updated_at: "now" }));
    await render(); await click("全文を編集"); await input(""); await click("保存");
    expect(host.textContent).toContain("本文は空です");
    await click("全文を編集"); expect(host.querySelector("textarea")?.value).toBe("");
  });
  it("keeps unfinished notes read-only", async () => {
    await render("保存済みの本文", true);
    expect(host.querySelector("button")).toBeNull(); expect(host.textContent).toContain("保存済みの本文");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
