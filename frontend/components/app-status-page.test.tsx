// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ErrorPage from "@/app/error";
import NotFound from "@/app/not-found";

afterEach(() => vi.unstubAllGlobals());
describe("themed error pages", () => {
  it("offers theme selection and reset without showing internal error details", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container),
      reset = vi.fn();
    try {
      await act(async () =>
        root.render(
          <ErrorPage reset={reset} error={new Error("private detail")} />,
        ),
      );
      expect(container.textContent).not.toContain("private detail");
      expect(container.querySelector('[role="group"][aria-label="表示テーマ"]')).not.toBeNull();
      await act(async () => container.querySelector("button")!.click());
      expect(reset).toHaveBeenCalledOnce();
      expect(container.querySelector("a")?.getAttribute("href")).toBe("/");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
  it("provides the same theme control for missing pages", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<NotFound />));
      expect(container.textContent).toContain("ページが見つかりません");
      expect(container.querySelector('[role="group"][aria-label="表示テーマ"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
