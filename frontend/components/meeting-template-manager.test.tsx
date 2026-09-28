// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeetingTemplate } from "@/lib/api";

import { MeetingTemplateManager } from "./meeting-template-manager";

const template: MeetingTemplate = {
  id: "template-1",
  name: "週次会議",
  definition: { realtime: [], final: [] },
  revision: 4,
  is_default: true,
  created_at: "2026-09-24T00:00:00Z",
  updated_at: "2026-09-24T00:00:00Z",
};

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<MeetingTemplateManager initialTemplates={[template]} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MeetingTemplateManager", () => {
  it("saves final card instructions with the template revision", async () => {
    const withCard: MeetingTemplate = { ...template, definition: { realtime: [], final: [{
      id: "summary", title: "要約", visible: true, show_when_empty: true, core_kind: "summary", fields: [],
    }] } };
    await act(async () => root.render(<MeetingTemplateManager key="instructions" initialTemplates={[withCard]} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')!.click());
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="AIへの指示"]')!;
    expect(input.maxLength).toBe(2000);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "理由と結論を整理する");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => withCard });
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "保存")!.click());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.expected_revision).toBe(4);
    expect(body.definition.final[0].instructions).toBe("理由と結論を整理する");
  });

  it("saves the selected template with its expected revision", async () => {
    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="テンプレート名"]');
    expect(nameInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, "週次レビュー");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const updated = { ...template, name: "週次レビュー", revision: 5 };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => updated,
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "保存");
    expect(save).not.toBeUndefined();
    await act(async () => { save!.click(); });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/meeting-templates/template-1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        name: "週次レビュー",
        definition: { realtime: [], final: [] },
        expected_revision: 4,
      }),
    }));
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("保存しました。新しい会議や、このテンプレートを選び直した再生成に適用されます。");
  });
});
