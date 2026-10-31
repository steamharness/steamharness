// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const root = path.resolve(import.meta.dirname, "../../skills/steamharness-generator/assets/kanban");
const listeners = [];
afterEach(() => {
  for (const listener of listeners.splice(0)) document.removeEventListener("visibilitychange", listener);
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function page(variant, { readError, stored } = {}) {
  const directory = path.join(root, variant);
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const modules = Object.assign({}, ...await Promise.all(["board-state.js", "board-storage.js"]
    .map(name => import(pathToFileURL(path.join(directory, name)).href))));
  document.body.innerHTML = html;
  const kv = {
    getValue: vi.fn(async () => {
      if (readError) throw Object.assign(new Error(readError), { code: readError });
      return stored;
    }),
    setValue: vi.fn(async () => undefined),
  };
  const get = vi.fn(() => ({ kv }));
  const callbacks = new Map();
  const host = {
    steamHarnessKanban: { databases: { get }, getConfiguration: () => ({ id: "review", params: {} }) },
    addEventListener: (name, callback) => callbacks.set(name, callback),
  };
  const addListener = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((name, listener, options) => {
    if (name === "visibilitychange") listeners.push(listener);
    addListener(name, listener, options);
  });
  document.querySelector("dialog").showModal = function () { this.open = true; };
  document.querySelector("dialog").close = function () { this.open = false; };
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1]
    .replace(/import\s*\{[^}]*\}\s*from\s*"\.\/[^"\n]+";/g, "");
  new Function("window", "document", ...Object.keys(modules), script)(host, document, ...Object.values(modules));
  await vi.waitFor(() => expect(document.querySelector("#board").getAttribute("aria-busy")).toBe("false"));
  return { kv, get, callbacks };
}

for (const variant of ["default", "parameters"]) {
  it(`${variant} restores and saves tasks using the declared database API`, async () => {
    const f = await page(variant, { stored: { version: 1, tasks: [
      { id: "saved", title: "Stored task", description: "Restored", status: "doing" },
    ] } });
    expect(f.get).toHaveBeenCalledWith("data");
    expect(f.kv.getValue).toHaveBeenCalledWith("kanban.board-state.v1:review");
    expect(document.querySelector("#board").textContent).toContain("Stored task");
    document.querySelector("#new-task").click();
    document.querySelector("#task-title").value = "New task";
    document.querySelector("#task-description").value = "Audit";
    document.querySelector("#save-task").click();
    f.callbacks.get("pagehide")();
    await vi.waitFor(() => expect(f.kv.setValue).toHaveBeenCalledWith("kanban.board-state.v1:review", {
      version: 1, tasks: expect.arrayContaining([
        expect.objectContaining({ title: "Stored task", status: "doing" }),
        expect.objectContaining({ title: "New task", description: "Audit", status: "todo" }),
      ]),
    }));
  });

  it(`${variant} allows temporary edits when the database is unbound`, async () => {
    const f = await page(variant, { readError: "DATABASE_UNBOUND" });
    expect(document.querySelector("#storage-status-text").textContent).toContain("临时模式");
    document.querySelector("#new-task").click();
    document.querySelector("#task-title").value = "Temporary task";
    document.querySelector("#save-task").click();
    f.callbacks.get("pagehide")();
    expect(document.querySelector("#board").textContent).toContain("Temporary task");
    expect(f.kv.setValue).not.toHaveBeenCalled();
  });

  it(`${variant} protects existing tasks when reading the database fails`, async () => {
    const f = await page(variant, { readError: "DATABASE_ACCESS_DENIED" });
    expect(document.querySelector("#new-task").disabled).toBe(true);
    expect([...document.querySelectorAll(".edit-action")].every(button => button.disabled)).toBe(true);
    // Even a dispatched save event must not turn fallback examples into stored data.
    document.querySelector("#task-title").value = "Rejected edit";
    document.querySelector("#save-task").click();
    f.callbacks.get("pagehide")();
    await Promise.resolve();
    expect(f.kv.setValue).not.toHaveBeenCalled();
    expect(document.querySelector("#board").textContent).not.toContain("Rejected edit");
  });
}
