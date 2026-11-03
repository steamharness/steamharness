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

async function page(variant, { readError, failWrite = false } = {}) {
  const directory = path.join(root, variant);
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const modules = Object.assign({}, ...await Promise.all(["board-state.js", "board-storage.js", "task-repository.js"]
    .map(name => import(pathToFileURL(path.join(directory, name)).href))));
  document.body.innerHTML = html;
  const rows = new Map([["saved", { rowVersion: "1", values: {
    id: "saved", configurationId: "review", title: "Stored task", description: "Restored", status: "doing", position: 0,
  } }]]);
  const task = {
    rows: vi.fn(async ({ where }) => {
      if (readError) throw Object.assign(new Error(readError), { code: readError });
      const items = [...rows.values()].filter(row => row.values.configurationId === where.configurationId);
      return { items, total: items.length };
    }),
    insert: vi.fn(async values => {
      if (failWrite) { failWrite = false; throw new Error("offline"); }
      const row = { values, rowVersion: "1" }; rows.set(values.id, row); return row;
    }),
    update: vi.fn(async ({ key, rowVersion, data }) => {
      const previous = rows.get(key.id);
      if (previous.rowVersion !== rowVersion) throw new Error("DATABASE_ROW_CONFLICT");
      const row = { values: { ...previous.values, ...data }, rowVersion: String(Number(rowVersion) + 1) };
      rows.set(key.id, row); return row;
    }),
    delete: vi.fn(async ({ key, rowVersion }) => {
      if (rows.get(key.id).rowVersion !== rowVersion) throw new Error("DATABASE_ROW_CONFLICT");
      rows.delete(key.id);
    }),
  };
  const connect = vi.fn(async () => ({ task })), data = { alias: "data", target: "browser" };
  const callbacks = new Map();
  const host = {
    steamHarnessKanban: { databases: { connect }, getConfiguration: () => ({ id: "review", params: {} }) },
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
  new Function("window", "document", "data", ...Object.keys(modules), script)(host, document, data, ...Object.values(modules));
  await vi.waitFor(() => expect(document.querySelector("#board").getAttribute("aria-busy")).toBe("false"));
  return { task, rows, connect, data, callbacks };
}

function addTask(title) {
  document.querySelector("#new-task").click();
  document.querySelector("#task-title").value = title;
  document.querySelector("#task-description").value = "Audit";
  document.querySelector("#save-task").click();
}

for (const variant of ["default", "parameters"]) {
  it(`${variant} restores rows and saves tasks with the generated connection`, async () => {
    const f = await page(variant);
    expect(f.connect).toHaveBeenCalledWith(f.data);
    expect(f.task.rows).toHaveBeenCalledWith(expect.objectContaining({ where: { configurationId: "review" } }));
    expect(document.querySelector("#board").textContent).toContain("Stored task");
    addTask("New task"); f.callbacks.get("pagehide")();
    await vi.waitFor(() => expect(f.task.insert).toHaveBeenCalledWith(expect.objectContaining({
      title: "New task", description: "Audit", status: "todo", configurationId: "review",
    })));
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  for (const readError of ["DATABASE_UNBOUND", "DATABASE_ACCESS_DENIED"]) {
    it(`${variant} blocks edits after ${readError}`, async () => {
      const f = await page(variant, { readError });
      expect(document.querySelector("#storage-status").dataset.state).toBe("error");
      expect(document.querySelector("#new-task").disabled).toBe(true);
      expect([...document.querySelectorAll(".edit-action")].every(button => button.disabled)).toBe(true);
      document.querySelector("#task-title").value = "Rejected edit";
      document.querySelector("#save-task").click(); f.callbacks.get("pagehide")();
      await Promise.resolve();
      expect(f.task.insert).not.toHaveBeenCalled(); expect(f.task.update).not.toHaveBeenCalled();
      expect(document.querySelector("#board").textContent).not.toContain("Rejected edit");
    });
  }

  it(`${variant} keeps failed edits visible and retries the same connection`, async () => {
    const f = await page(variant, { failWrite: true });
    addTask("Retained draft"); f.callbacks.get("pagehide")();
    await vi.waitFor(() => expect(document.querySelector("#storage-status").dataset.state).toBe("error"));
    expect(document.querySelector("#board").textContent).toContain("Retained draft");
    document.querySelector("#retry-storage").click();
    await vi.waitFor(() => expect(document.querySelector("#storage-status").dataset.state).toBe("saved"));
    expect([...f.rows.values()].filter(row => row.values.title === "Retained draft")).toHaveLength(1);
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
}
