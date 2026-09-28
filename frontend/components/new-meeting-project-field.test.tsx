// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeApi, type Project } from "@/lib/api";
import { NewMeetingProjectField } from "./new-meeting-project-field";

vi.mock("@/lib/api", () => ({ knowledgeApi: { saveProject: vi.fn() } }));
const parent: Project = { id: "parent", name: "就活", parent_id: null, profile_id: null, notes: "", revision: 1 };
const child: Project = { ...parent, id: "child", name: "A社", parent_id: "parent" };
let container: HTMLDivElement;
let root: Root;
const busy = vi.fn();
const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault());

function Host() {
  const [projects, setProjects] = useState([parent, child]);
  return <form onSubmit={onSubmit}><NewMeetingProjectField projects={projects} initialProjectId={child.id}
    disabled={false} onBusyChange={busy} onCreated={(project) => setProjects((items) => [...items, project])} /></form>;
}
function button(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
}
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function name(value: string) {
  const input = container.querySelector<HTMLInputElement>("#new-meeting-project-name")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Host />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("inline project creation", () => {
  it("creates a child and automatically selects it without submitting the meeting", async () => {
    vi.mocked(knowledgeApi.saveProject).mockResolvedValue({ ...child, id: "new-child", name: "B社" });
    await click(button("＋ 新規作成")); await name(" B社 ");
    expect(container.querySelector<HTMLSelectElement>("#new-meeting-project-parent")!.value).toBe(parent.id);
    expect(container.querySelectorAll("#new-meeting-project-parent option")).toHaveLength(2);
    await click(button("作成して選択"));
    expect(knowledgeApi.saveProject).toHaveBeenCalledWith(null, { name: "B社", parent_id: parent.id, profile_id: null, notes: "" });
    expect(container.querySelector<HTMLSelectElement>('[name="project_id"]')!.value).toBe("new-child");
    expect(new FormData(container.querySelector("form")!).get("project_id")).toBe("new-child");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });
  it("can create a top-level project", async () => {
    vi.mocked(knowledgeApi.saveProject).mockResolvedValue({ ...parent, id: "new-parent", name: "研究" });
    await click(button("＋ 新規作成")); await name("研究");
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>("#new-meeting-project-parent")!;
      select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button("作成して選択"));
    expect(knowledgeApi.saveProject).toHaveBeenCalledWith(null, { name: "研究", parent_id: null, profile_id: null, notes: "" });
    expect(container.querySelector<HTMLSelectElement>('[name="project_id"]')!.value).toBe("new-parent");
  });
  it("retains the existing selection and entered name on failure", async () => {
    vi.mocked(knowledgeApi.saveProject).mockRejectedValue(new Error("作成できません"));
    await click(button("＋ 新規作成"));
    expect(button("作成して選択").disabled).toBe(true);
    await name("B社"); await click(button("作成して選択"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("作成できません");
    expect(container.querySelector<HTMLInputElement>("#new-meeting-project-name")!.value).toBe("B社");
    expect(container.querySelector<HTMLSelectElement>('[name="project_id"]')!.value).toBe(child.id);
    expect(busy).toHaveBeenLastCalledWith(false);
  });
  it("creates with Enter without triggering the surrounding meeting form", async () => {
    vi.mocked(knowledgeApi.saveProject).mockResolvedValue({ ...child, id: "enter-child", name: "B社" });
    await click(button("＋ 新規作成")); await name("B社");
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => container.querySelector("input")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(knowledgeApi.saveProject).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
