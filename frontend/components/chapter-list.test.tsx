// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chapterThumbnailsApi, type ChapterThumbnails, type Job } from "@/lib/api";
import { ChapterList } from "./chapter-list";

vi.mock("@/lib/api", () => ({ chapterThumbnailsApi: { ensure: vi.fn(), get: vi.fn(), retry: vi.fn() } }));

const chapters = [{ id: "chapter", title: "話題", startMs: 1500, endMs: 7000 }];
const ready: ChapterThumbnails = {
  status: "completed", thumbnails: [{ chapter_id: "chapter", start_ms: 1500, url: "/api/frame.jpg" }], job: null,
};
const queued: ChapterThumbnails = { status: "queued", thumbnails: [], job: null };
let root: Root;
let host: HTMLDivElement;
async function render(mediaKind: "audio" | "video" = "video", analysisId = "version", jobState = "") {
  await act(async () => { root.render(<ChapterList key={analysisId} meetingId="meeting" analysisId={analysisId} mediaKind={mediaKind} chapters={chapters} jobState={jobState} />); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers(); vi.resetAllMocks();
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  vi.mocked(chapterThumbnailsApi.ensure).mockResolvedValue(ready);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("automatic chapter thumbnails", () => {
  it("shows the frame while keeping duration and chapter seeking", async () => {
    await render();
    expect(chapterThumbnailsApi.ensure).toHaveBeenCalledWith("meeting", "version", expect.any(AbortSignal));
    const image = host.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/api/frame.jpg");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(host.querySelector("[data-seek-ms]")?.getAttribute("data-seek-ms")).toBe("1500");
    expect(host.textContent).toContain("00:05");
    expect(host.textContent).toContain("00:01");
  });
  it("polls a pending job then stops once frames arrive", async () => {
    vi.mocked(chapterThumbnailsApi.ensure).mockResolvedValue(queued);
    vi.mocked(chapterThumbnailsApi.get).mockResolvedValue(ready);
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("作成中");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.querySelector("img")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(chapterThumbnailsApi.get).toHaveBeenCalledTimes(1);
  });
  it("reserves a follow-up when chapters were added while processing", async () => {
    vi.mocked(chapterThumbnailsApi.ensure).mockResolvedValueOnce(queued).mockResolvedValueOnce(ready);
    vi.mocked(chapterThumbnailsApi.get).mockResolvedValue({ ...queued, status: "missing" });
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(chapterThumbnailsApi.ensure).toHaveBeenCalledTimes(2);
    expect(host.querySelector("img")).not.toBeNull();
  });
  it("makes no request for audio-only chapters", async () => {
    await render("audio");
    expect(chapterThumbnailsApi.ensure).not.toHaveBeenCalled();
    expect(host.querySelector("svg.lucide-headphones")).not.toBeNull();
    expect(host.querySelector("[data-seek-ms]")).not.toBeNull();
  });
  it("keeps finished frames after a failure and retries only on request", async () => {
    vi.mocked(chapterThumbnailsApi.ensure).mockResolvedValueOnce({
      ...ready, status: "failed", job: { id: "job" } as Job,
    }).mockResolvedValue(ready);
    vi.mocked(chapterThumbnailsApi.retry).mockResolvedValue({ id: "job" } as Job);
    await render();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector("img")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(chapterThumbnailsApi.retry).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); });
    expect(chapterThumbnailsApi.retry).toHaveBeenCalledOnce();
    expect(chapterThumbnailsApi.retry).toHaveBeenCalledWith("job");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("offers retry after communication fails and falls back if image loading fails", async () => {
    vi.mocked(chapterThumbnailsApi.ensure).mockRejectedValueOnce(new Error("通信エラー")).mockResolvedValue(ready);
    await render();
    expect(host.textContent).toContain("通信エラー");
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); });
    await act(async () => { host.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("svg.lucide-film")).not.toBeNull();
  });
  it("never displays a frame for a different chapter time", async () => {
    vi.mocked(chapterThumbnailsApi.ensure).mockResolvedValue({ ...ready, thumbnails: [{ ...ready.thumbnails[0], start_ms: 5000 }] });
    await render();
    expect(host.querySelector("img")).toBeNull();
  });
  it("updates when a retry from the job panel has completed", async () => {
    vi.mocked(chapterThumbnailsApi.ensure).mockResolvedValueOnce({ ...queued, status: "failed" }).mockResolvedValue(ready);
    await render("video", "version", "job:failed:1");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await render("video", "version", "job:completed:2");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("img")).not.toBeNull();
  });
  it("aborts the previous version and discards its late response", async () => {
    let complete!: (value: ChapterThumbnails) => void;
    vi.mocked(chapterThumbnailsApi.ensure).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockResolvedValue({ ...ready, thumbnails: [{ ...ready.thumbnails[0], url: "/api/new-frame.jpg" }] });
    await render();
    const signal = vi.mocked(chapterThumbnailsApi.ensure).mock.calls[0][2]!;
    await render("video", "new-version");
    expect(signal.aborted).toBe(true);
    await act(async () => { complete(ready); });
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/api/new-frame.jpg");
  });
});
