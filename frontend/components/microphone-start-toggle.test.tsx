// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MicrophoneStartToggle } from "./microphone-start-toggle";

describe("microphone start setting", () => {
  it("switches between muted and ON without submitting a surrounding form", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    function Host() {
      const [muted, setMuted] = useState(true);
      return <form onSubmit={submit}><MicrophoneStartToggle muted={muted} disabled={false} onChange={setMuted} /></form>;
    }
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Host />));
      const button = container.querySelector("button")!;
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.textContent).toContain("ミュートで開始");
      await act(async () => button.click());
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.textContent).toContain("ONで開始");
      await act(async () => button.click());
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(submit).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
  });
});
