// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchLiveSpeakerRenamed, dispatchSpeakerRenamed } from "@/lib/speaker-events";
import { InlineSpeakerName } from "./inline-speaker-name";

let host: HTMLDivElement;
let root: Root;
const speakerId = "932f2d85-ab13-4c14-aedf-9f0ad5701bde";
const saved = { id: speakerId, display_name: "エージェント", internal_name: "SPEAKER_00" };
const response = (data: unknown, status = 200) => ({
  ok: status === 200, status, json: async () => data,
});

function render(live = false) {
  act(() => root.render(<InlineSpeakerName meetingId="m" speakerName="話者 1"
    {...(live ? { segmentIds: ["s1", "s2"] } : { speakerId })} />));
}
function edit(name = "話者 1") {
  act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${name}の名前を変更"]`)!.click());
}
function enter(value: string) {
  const input = host.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function submit() {
  return act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => response(saved)));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("speaker name editing", () => {
  it("saves a trimmed Final name and immediately updates all occurrences", async () => {
    act(() => root.render(<>
      <InlineSpeakerName meetingId="m" speakerId={speakerId} speakerName="話者 1" />
      <InlineSpeakerName meetingId="m" speakerId={speakerId} speakerName="話者 1" />
    </>));
    edit(); enter(" エージェント "); await submit();
    expect(fetch).toHaveBeenCalledWith(`/api/v1/meetings/m/speakers/${speakerId}`, expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ display_name: "エージェント" }),
    }));
    expect(host.querySelectorAll('[aria-label="エージェントの名前を変更"]')).toHaveLength(2);
    edit("エージェント");
    expect(host.querySelector("input")!.value).toBe("エージェント");
  });
  it("uses a separate saved-Live endpoint and exact segment IDs", async () => {
    vi.mocked(fetch).mockResolvedValue(response([
      { id: "s1", provisional_speaker_name: "エージェント", provisional_speaker_label: "話者 1" },
      { id: "s2", provisional_speaker_name: "エージェント", provisional_speaker_label: "話者 1" },
    ]) as Response);
    render(true); edit();
    expect(host.textContent).toContain("同じ話者番号を全体に反映（暫定）");
    enter("エージェント"); await submit();
    expect(fetch).toHaveBeenCalledWith("/api/v1/meetings/m/transcript/live-speaker-name", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ display_name: "エージェント", segment_ids: ["s1", "s2"] }),
    }));
    expect(host.querySelector('[aria-label="エージェントの名前を変更"]')).not.toBeNull();
  });
  it("updates all returned Live segments while keeping Final names independent", () => {
    render(true);
    act(() => dispatchLiveSpeakerRenamed({ segmentIds: ["another-turn"], speakerName: "別の話者" }));
    act(() => dispatchSpeakerRenamed({ speakerId, displayName: "確定話者", speakerName: "確定話者" }));
    expect(host.textContent).toBe("話者 1");
    act(() => dispatchLiveSpeakerRenamed({ segmentIds: ["s2"], speakerName: "同じ発言" }));
    expect(host.textContent).toBe("同じ発言");
  });
  it("immediately renames separated occurrences returned by the saved-Live API", async () => {
    act(() => root.render(<>
      <InlineSpeakerName meetingId="m" segmentIds={["s1"]} speakerName="話者 1" />
      <InlineSpeakerName meetingId="m" segmentIds={["s3"]} speakerName="以前の名前" />
      <InlineSpeakerName meetingId="m" segmentIds={["s2"]} speakerName="話者 2" />
    </>));
    vi.mocked(fetch).mockResolvedValue(response(["s1", "s3"].map((id) => ({
      id, provisional_speaker_name: "田中", provisional_speaker_label: "話者 1",
    }))) as Response);
    edit(); enter("田中"); await submit();
    expect(host.querySelectorAll('[aria-label="田中の名前を変更"]')).toHaveLength(2);
    expect(host.querySelector('[aria-label="話者 2の名前を変更"]')).not.toBeNull();
  });
  it.each([false, true])("clears a name and restores the stored label (Live=%s)", async (live) => {
    vi.mocked(fetch).mockResolvedValue(response(live
      ? [{ id: "s1", provisional_speaker_name: null, provisional_speaker_label: "話者 1" }]
      : { ...saved, display_name: null }) as Response);
    render(live); edit(); enter(" "); await submit();
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).display_name).toBeNull();
    expect(host.textContent).toBe(live ? "話者 1" : "SPEAKER_00");
  });
  it.each([
    { detail: [{ type: "uuid_parsing", msg: "話者IDの形式が不正です", input: { private: "value" } }] },
    { detail: { message: "unexpected object" } },
    { detail: [null, 1, {}] },
    { detail: "話者が見つかりません" },
  ])("shows readable API errors and keeps the draft for retry: %j", async (body) => {
    vi.mocked(fetch).mockResolvedValueOnce(response(body, 422) as Response);
    render(); edit(); enter("エージェント"); await submit();
    const error = host.querySelector('[role="alert"]')!.textContent!;
    expect(error).not.toContain("[object Object]");
    expect(error).not.toContain("private");
    expect(error).toMatch(/話者|422/);
    expect(host.querySelector("input")!.value).toBe("エージェント");
    await submit();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toBe("エージェント");
  });
  it("preserves the draft after a network failure and allows cancel", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("接続できませんでした"));
    render(); edit(); enter("入力中"); await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("接続できませんでした");
    expect(host.querySelector("input")!.value).toBe("入力中");
    act(() => host.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
    expect(host.textContent).toBe("話者 1");
  });
  it("blocks duplicate submissions and Escape while saving", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(); edit(); enter("エージェント");
    act(() => {
      const form = host.querySelector("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.querySelector("input")!.disabled).toBe(true);
    act(() => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector("form")).not.toBeNull();
    await act(async () => resolve(response(saved) as Response));
    expect(host.textContent).toBe("エージェント");
  });
  it("validates name length without making an API request", async () => {
    render(); edit(); enter("長".repeat(201)); await submit();
    expect(fetch).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("200文字");
  });
});
