// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcriptsApi } from "@/lib/api";
import { FinalTranscriptAction } from "./final-transcript-action";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({ transcriptsApi: { createFinal: vi.fn() } }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); refresh.mockReset(); vi.mocked(transcriptsApi.createFinal).mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("explicit Final transcription action", () => {
  it("reserves whole transcription only after the separate action and prevents duplicate requests", async () => {
    let finish!: (value: Awaited<ReturnType<typeof transcriptsApi.createFinal>>) => void;
    vi.mocked(transcriptsApi.createFinal).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await act(async () => root.render(<FinalTranscriptAction meetingId="meeting" ready processing={false} />));
    const button = host.querySelector("button")!;
    expect(transcriptsApi.createFinal).not.toHaveBeenCalled();
    await act(async () => { button.click(); button.click(); });
    expect(transcriptsApi.createFinal).toHaveBeenCalledTimes(1);
    expect(transcriptsApi.createFinal).toHaveBeenCalledWith("meeting");
    expect(button.disabled).toBe(true);
    await act(async () => finish({ id: "job" } as Awaited<ReturnType<typeof transcriptsApi.createFinal>>));
    expect(refresh).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
  });
  it("disables recording/processing actions and keeps an error visible for retry", async () => {
    await act(async () => root.render(<FinalTranscriptAction meetingId="meeting" ready={false} processing={false} />));
    expect(host.querySelector("button")!.disabled).toBe(true);
    await act(async () => root.render(<FinalTranscriptAction meetingId="meeting" ready processing />));
    expect(host.querySelector("button")!.disabled).toBe(true);
    await act(async () => root.render(<FinalTranscriptAction meetingId="meeting" ready processing={false} />));
    vi.mocked(transcriptsApi.createFinal).mockRejectedValueOnce(new Error("全体処理を開始できません"));
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("全体処理を開始できません");
    expect(host.querySelector("button")!.disabled).toBe(false);
    vi.mocked(transcriptsApi.createFinal).mockResolvedValue({ id: "job" } as Awaited<ReturnType<typeof transcriptsApi.createFinal>>);
    await act(async () => host.querySelector("button")!.click());
    expect(refresh).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
