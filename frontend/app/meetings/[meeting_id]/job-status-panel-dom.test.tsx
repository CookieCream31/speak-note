// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, MeetingStatus } from "@/lib/api";
import { JobStatusPanel } from "./job-status-panel";

const refresh = vi.fn();
const router = { refresh };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const completed = { id: "thumbnail", type: "generate_thumbnails", status: "completed", attempts: 2,
  progress: 100, created_at: "2026-10-15T00:00:00Z", error_message: null } as Job;
let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.fn<typeof fetch>();
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
async function render(status: MeetingStatus = "failed", jobs: Job[] = [completed]) {
  await act(async () => { root.render(<JobStatusPanel meetingId="meeting" meetingStatus={status} initialJobs={jobs} />); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers(); vi.resetAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  fetchMock.mockResolvedValue(response({ status: "completed" }));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("meeting status reconciliation", () => {
  it("refreshes a stale failed header after all jobs have completed", async () => {
    await render();
    expect(host.textContent).toContain("すべて完了");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/meetings/meeting/reconcile-status", expect.objectContaining({ method: "POST" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("preserves a genuine failure when the server cannot verify completion", async () => {
    fetchMock.mockResolvedValue(response({ status: "failed" }));
    await render();
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each(["created", "recording", "completed"] as MeetingStatus[])("does not reconcile a %s meeting", async (status) => {
    await render(status); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not automatically reconcile an unresolved job failure", async () => {
    await render("failed", [{ ...completed, status: "failed", error_message: "FFmpeg failed" }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("1工程で確認が必要");
  });
  it("waits until processing has finished then updates the header", async () => {
    fetchMock.mockImplementation(async (input) => String(input).endsWith("/jobs")
      ? response([completed]) : response({ status: "completed" }));
    await render("failed", [{ ...completed, status: "running" }]);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("すべて完了");
  });
  it("manual update refreshes the header even without a processing transition", async () => {
    fetchMock.mockResolvedValue(response([completed]));
    await render("completed");
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "更新")!.click(); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("reports communication failure and allows a manual retry", async () => {
    fetchMock.mockRejectedValueOnce(new Error("接続に失敗しました"));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("接続に失敗しました");
    fetchMock.mockImplementation(async (input) => String(input).endsWith("/jobs")
      ? response([completed]) : response({ status: "completed" }));
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "更新")!.click(); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("does not update an unmounted page when an old request completes", async () => {
    let complete!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await render();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    act(() => root.render(<div>Other page</div>));
    expect(signal?.aborted).toBe(true);
    await act(async () => { complete(response({ status: "completed" })); });
    expect(refresh).not.toHaveBeenCalled();
  });
});
