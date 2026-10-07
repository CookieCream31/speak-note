// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { meetingsApi, type Meeting } from "@/lib/api";
import { MeetingTitleEditor } from "./meeting-title-editor";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({ meetingsApi: { update: vi.fn() } }));
let host: HTMLDivElement;
let root: Root;
const saved = { id: "m", title: "変更した会議" } as Meeting;

function edit() {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="会議タイトルを編集"]')!.click());
  return host.querySelector("input")!;
}
function enter(value: string) {
  const input = host.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(meetingsApi.update).mockResolvedValue(saved);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<MeetingTitleEditor meetingId="m" title="元の会議" />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("meeting title editor", () => {
  it("saves a trimmed title without changing other meeting fields and refreshes the heading", async () => {
    edit();
    enter("  変更した会議  ");
    await submit();
    expect(meetingsApi.update).toHaveBeenCalledWith("m", { title: "変更した会議" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("保存しました");
    act(() => root.render(<MeetingTitleEditor meetingId="m" title={saved.title} />));
    expect(host.querySelector("h1")?.textContent).toBe(saved.title);
    expect(host.querySelector("form")).toBeNull();
  });

  it("focuses the input and cancels with Escape without saving", () => {
    const input = edit();
    expect(document.activeElement).toBe(input);
    expect(input.selectionEnd).toBe(input.value.length);
    enter("キャンセルする名前");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector("h1")?.textContent).toBe("元の会議");
    expect(meetingsApi.update).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector('[aria-label="会議タイトルを編集"]'));
    expect(edit().value).toBe("元の会議");
  });

  it("rejects whitespace-only and oversized titles", async () => {
    edit();
    enter("   ");
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("1〜200文字");
    enter("a".repeat(201));
    await submit();
    expect(meetingsApi.update).not.toHaveBeenCalled();
    expect(host.querySelector("input")?.maxLength).toBe(200);
  });

  it("keeps the draft and original title when saving fails, then allows retry", async () => {
    vi.mocked(meetingsApi.update).mockRejectedValueOnce(new Error("接続できません"));
    edit();
    enter(saved.title);
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("接続できません");
    expect(host.querySelector("input")?.value).toBe(saved.title);
    expect(refresh).not.toHaveBeenCalled();
    await submit();
    expect(meetingsApi.update).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not submit twice while a request is pending", async () => {
    let resolve!: (meeting: Meeting) => void;
    vi.mocked(meetingsApi.update).mockReturnValue(new Promise((done) => { resolve = done; }));
    edit();
    enter(saved.title);
    await submit();
    expect(host.querySelector("input")?.disabled).toBe(true);
    expect(Array.from(host.querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
    await submit();
    expect(meetingsApi.update).toHaveBeenCalledTimes(1);
    await act(async () => resolve(saved));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
