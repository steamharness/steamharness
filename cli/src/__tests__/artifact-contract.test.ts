import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initI18n } from "@steamharness/i18n";
import { materializeAggregateDownload, packProject } from "../workspace";

const folders: string[] = [];
beforeEach(() => { vi.stubEnv("STEAMHARNESS_WORKSPACE_PACKS_DIR", ""); initI18n({ preference: "en" }); });
afterEach(async () => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const projectId = "00000000-0000-4000-8000-000000000001";
const declaration = { id: projectId, name: "Artifacts", version: "1.0.0", defaultEntry: "main",
  entries: [{ entryId: "main", root: ".", type: "workflow", name: "Main", entry: "index.ts", databases: [] }] };
const sourceFiles = () => [
  { path: "package.json", content: '{"name":"artifacts","type":"module"}' },
  { path: "steamharness.json", content: JSON.stringify(declaration) },
  { path: "index.ts", content: "export {};\n" },
];
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-artifact-contract-")); folders.push(root); return root;
}

it.skipIf(process.platform !== "darwin")("packs extended-attribute files without AppleDouble entries", async () => {
  const project = await directory();
  for (const file of sourceFiles()) await writeFile(path.join(project, file.path), file.content);
  const execute = promisify(execFile);
  await execute("xattr", ["-w", "com.steamharness.artifact-test", "generated", path.join(project, "index.ts")]);
  const archive = await packProject("artifacts", undefined, project);
  const { stdout } = await execute("tar", ["-tzf", archive]);
  expect(stdout).toContain("/index.ts");
  expect(stdout.split("\n").some(filename => filename.split("/").some(part => part.startsWith("._")))).toBe(false);
});

it("rejects downloads missing a declared source entry without installing a partial project", async () => {
  const root = await directory(), target = path.join(root, "download");
  await expect(materializeAggregateDownload({ projectId, files: sourceFiles().filter(file => file.path !== "index.ts") }, target)).rejects.toThrow(/required upload path/i);
  expect(await readdir(root)).toEqual([]);
});

it("checks a child Kanban's required HTML and preserves its complete asset set", async () => {
  const root = await directory();
  const files = [
    { path: "package.json", content: '{"name":"artifacts","type":"module"}' },
    { path: "steamharness.json", content: JSON.stringify({ ...declaration, defaultEntry: "board", entries: [{ entryId: "board", root: "apps/board" }] }) },
    { path: "apps/board/steamharness.json", content: JSON.stringify({ type: "kanban", name: "Board" }) },
    { path: "dist/steamharness/entries/apps%2Fboard/build/board/Board.js", content: 'document.body.dataset.ready = "yes";' },
    { path: "dist/steamharness/entries/apps%2Fboard/build/board/board.css", content: "body { color: teal; }" },
  ];
  await expect(materializeAggregateDownload({ projectId, files }, path.join(root, "incomplete"))).rejects.toThrow(/required upload path/i);
  files.push({ path: "dist/steamharness/entries/apps%2Fboard/build/board/index.html", content: '<link rel="stylesheet" href="board.css"><script src="Board.js"></script>' });
  const target = path.join(root, "complete");
  await materializeAggregateDownload({ projectId, files }, target);
  for (const file of files) {
    const content = await readFile(path.join(target, file.path), "utf8");
    if (file.path === "steamharness.json") expect(JSON.parse(content)).toEqual(JSON.parse(file.content));
    else expect(content).toBe(file.content);
  }
});

it.each([".local/auth.json", ".workflow/runtime/history.json", ".release/live-runtime/auth.json", "dist/cache/token.json", "dist/reports/run.json", "dist/release/old.tgz", "dist/steamharness/unverified.json", "dist/unregistered/output.js"])("rejects downloaded runtime or unregistered artifact %s", async filename => {
  const root = await directory();
  await expect(materializeAggregateDownload({ projectId, files: [...sourceFiles(), { path: filename, content: "private" }] }, path.join(root, "download"))).rejects.toThrow(/download path|downloaded.*artifact/i);
  expect(await readdir(root)).toEqual([]);
});

it.each(["../escape", "../../../../escape", "board/child", "board\\child", "..", "con", "nul.txt", "board\u0001", "board."])("rejects pack alias %s before writing or cleaning project paths", async alias => {
  initI18n({ preference: "en" });
  const root = await directory(), project = path.join(root, "project"); await mkdir(project);
  for (const file of sourceFiles()) await writeFile(path.join(project, file.path), file.content);
  await mkdir(path.join(project, "dist/steamharness/entries/apps%2Fboard/build/board"), { recursive: true });
  await writeFile(path.join(project, "dist/steamharness/entries/apps%2Fboard/build/board/keep.txt"), "keep");
  await expect(packProject(alias, undefined, project)).rejects.toThrow(/project name/i);
  expect(await readFile(path.join(project, "dist/steamharness/entries/apps%2Fboard/build/board/keep.txt"), "utf8")).toBe("keep");
  expect(await readFile(path.join(project, "index.ts"), "utf8")).toBe("export {};\n");
});

it("removes only its staging directory when a package is incomplete", async () => {
  initI18n({ preference: "en" });
  const project = await directory();
  for (const file of sourceFiles().filter(file => file.path !== "index.ts")) await writeFile(path.join(project, file.path), file.content);
  const other = path.join(project, "dist/release/tmp/other-job"); await mkdir(other, { recursive: true });
  await writeFile(path.join(other, "keep.txt"), "keep");
  await expect(packProject("artifacts", undefined, project)).rejects.toThrow(/required upload path/i);
  expect(await readdir(path.join(project, "dist/release/tmp"))).toEqual(["other-job"]);
  expect(await readFile(path.join(other, "keep.txt"), "utf8")).toBe("keep");
});
