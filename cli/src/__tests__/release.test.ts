import { projectDataDirectorySync } from "../web/project-data-directory";
import { main as runWebCommand } from "../web";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProjectRelease, prepareReleaseRun, resolveProjectDistribution } from "../release/build";
import { readProjectReleaseSync } from "@steamharness/project-manifest/release-node";
import { createMemoryRuntimePersistence } from "steamharness/runtime-storage";
import { createLocalProjectConfigurationStore, inspectLocalProjectStructure, projectUsesConfiguredAgentModels, runLocalProjectWithReport, withUserSettings, readProjectConfigurationDefinition } from "steamharness";
import { startWebServer } from "./web-test-storage";
import { materializeAggregateDownload, packProject } from "../workspace";
import { createProjectUploadPlan } from "@steamharness/project-upload/node";
import { initI18n } from "@steamharness/i18n";

const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const id = "72e34bc3-7bbd-4d45-b38b-f941ff856424";
const source = `const steamharness=globalThis.steamharness;
const main=steamharness.defineProject({name:'answer',async run(){return steamharness.createOutputPayload({items:[{id:'answer',title:'Answer',contentType:'text',content:'release works'}]});}});
export const executor=steamharness.defineExecutor({projectType:'workflow',defaultEntrypoint:'main',entrypoints:[steamharness.defineEntrypoint({id:'main',title:'Main',workflow:main,createInput:()=>({errCode:0,errMessage:''})})]});`;
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "steamharness-release-test-"))); folders.push(directory);
  const host = await mkdtemp(path.join(os.tmpdir(), "release-test-user-")); folders.push(host); vi.spyOn(os, "homedir").mockReturnValue(host);
  await mkdir(path.join(directory, "node_modules/@steamharness"), { recursive: true });
  await symlink(path.resolve("../harness"), path.join(directory, "node_modules/steamharness"), "dir");
  await symlink(path.resolve("."), path.join(directory, "node_modules/@steamharness/cli"), "dir");
  const declaration = { id, name: "release-test", version: "1.0.0", defaultEntry: "main", entries: [{ entryId: "main", root: ".", name: "Main", type: "workflow", entry: "index.ts", databases: [] }], release: {} };
  await writeFile(path.join(directory, "steamharness.json"), JSON.stringify(declaration));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "release-test", type: "module", version: "1.0.0" }));
  await writeFile(path.join(directory, "index.ts"), source);
  return { directory, declaration };
}
async function expectCompactRelease(directory: string) {
  const manifest = readProjectReleaseSync(directory)!;
  for (const file of [...manifest.files.filter(file => file.path.toLowerCase().endsWith(".json")).map(file => file.path), "steamharness.release.json"]) {
    expect(await readFile(path.join(directory, file), "utf8"), file).not.toMatch(/[\r\n]/);
  }
}
it("builds a portable compiled project with readable metadata and checks inventory on roundtrip", async () => {
  initI18n({ preference: "en" });
  const { directory } = await fixture();
  const result = await buildProjectRelease(directory);
  expect(result.directory).toBe(path.join(directory, 'dist/steamharness/release/project'));
  expect(result.archive.startsWith(path.join(directory, 'dist/steamharness/release') + path.sep)).toBe(true);
  expect(await readdir(path.join(directory, 'dist'))).toEqual(['steamharness']);
  const manifest = readProjectReleaseSync(result.directory)!;
  const structure = JSON.parse(await readFile(path.join(result.directory, "entries/main/structure.json"), "utf8"));
  expect(structure).toMatchObject({ version: 2, encoding: "brotli-base64", projectId: id, entryId: "main", entryName: "Main", projectType: "workflow" });
  expect(structure.report).toBeUndefined();
  expect(structure.scripts).toBeUndefined();
  expect(manifest.entries.map(entry => entry.entryId)).toEqual(["main"]);
  expect(manifest.files.some(file => /\.(ts|map)$/.test(file.path))).toBe(false);
  expect(inspectLocalProjectStructure({ projectDir: result.directory }).entrypoints?.[0].title).toBe("Main");
  expect((await buildProjectRelease(directory)).cached).toBe(true);
  const snapshot = await prepareReleaseRun(directory);
  await expectCompactRelease(result.directory);
  await expectCompactRelease(snapshot.directory);
  expect(snapshot.directory).not.toBe(result.directory);
  expect(snapshot.directory.startsWith(path.join(directory, 'dist/steamharness/release/snapshots') + path.sep)).toBe(true);
  const plan = await createProjectUploadPlan(result.directory);
  const download = path.join(directory, "download");
  await materializeAggregateDownload({ projectId: id, files: await Promise.all(plan.files.map(async file => ({ path: file.path, content: (await readFile(file.absolutePath)).toString("base64"), encoding: "base64" as const }))) }, download);
  expect(readProjectReleaseSync(download)?.buildId).toBe(result.buildId);
  await expectCompactRelease(download);
  expect(await packProject("release-test", undefined, directory)).toMatch(/\.tgz$/);
  const run = await runLocalProjectWithReport({ projectDir: download, storage: { host: "local", local: { runtimePersistence: createMemoryRuntimePersistence() } } });
  expect(run.status, JSON.stringify(run)).toBe("success");
  await writeFile(path.join(result.directory, "entries/main/index.mjs"), "tampered");
  expect(() => readProjectReleaseSync(result.directory)).toThrow(/integrity/);
  expect(readProjectReleaseSync(snapshot.directory)?.buildId).toBe(result.buildId);
});

it("compacts copied root and entry JSON assets without modifying source or rounding their numbers", async () => {
  const { directory, declaration } = await fixture();
  const asset = '{\n  "large": 9007199254740993,\n  "text": " keep  spaces\\ninside the value "\n}\n';
  const configuration = { version: 1, fields: [{ name: "label", type: "string", defaultValue: " keep  spaces\ninside the value " }] };
  await writeFile(path.join(directory, "asset.json"), asset);
  await writeFile(path.join(directory, "configuration.json"), JSON.stringify(configuration, null, 2));
  await writeFile(path.join(directory, "steamharness.json"), JSON.stringify({ ...declaration,
    entries: [{ ...declaration.entries[0], configuration: "configuration.json" }],
    release: { files: ["asset.json"], entryOverrides: { main: { assets: ["asset.json"] } } } }));
  const release = await buildProjectRelease(directory);
  await expectCompactRelease(release.directory);
  for (const relative of ["asset.json", "entries/main/asset.json"]) {
    const compact = await readFile(path.join(release.directory, relative), "utf8");
    expect(compact).toContain('"large":9007199254740993');
    expect(JSON.parse(compact)).toEqual(JSON.parse(asset));
  }
  expect(await readFile(path.join(directory, "asset.json"), "utf8")).toBe(asset);
  expect(await readFile(path.join(directory, "configuration.json"), "utf8")).toBe(JSON.stringify(configuration, null, 2));
  const inventory = await readFile(path.join(release.directory, "steamharness.release.json"), "utf8");
  await writeFile(path.join(directory, "asset.json"), "{broken}");
  await expect(buildProjectRelease(directory)).rejects.toThrow(/Invalid release JSON: .*asset.json/);
  expect(await readFile(path.join(release.directory, "steamharness.release.json"), "utf8")).toBe(inventory);
  expect(readProjectReleaseSync(release.directory)?.buildId).toBe(release.buildId);
});
it("serializes concurrent builds and preserves the previous release after build failure", async () => {
  const { directory } = await fixture();
  const [first, second] = await Promise.all([buildProjectRelease(directory), buildProjectRelease(directory)]);
  expect(first.buildId).toBe(second.buildId);
  expect([first.cached, second.cached].sort()).toEqual([false, true]);
  await writeFile(path.join(directory, "index.ts"), "this is invalid source");
  await expect(buildProjectRelease(directory)).rejects.toThrow();
  expect(readProjectReleaseSync(first.directory)?.buildId).toBe(first.buildId);
  await expect(resolveProjectDistribution(directory)).rejects.toThrow();
});

it("prepares entry-specific launch folders while retaining the original release identity", async () => {
  const { directory, declaration } = await fixture();
  await writeFile(path.join(directory, "steamharness.json"), JSON.stringify({ ...declaration,
    projectCard: { icon: "boxes", iconBackgroundColor: "#123456" }, entries: [...declaration.entries, { ...declaration.entries[0], entryId: "other" }] }));
  const release = await buildProjectRelease(directory);
  const initial = await readFile(path.join(release.directory, "steamharness.json"), "utf8");
  const selected = await prepareReleaseRun(directory, { entryId: "other" });
  const defaultRun = await prepareReleaseRun(directory, { entryId: "main" });
  expect(selected.directory).not.toBe(defaultRun.directory);
  const document = JSON.parse(await readFile(path.join(selected.directory, "steamharness.json"), "utf8"));
  expect(document.defaultEntry).toBe("other"); expect(document.id).toBe(id);
  expect(document.projectCard.icon).toBe("boxes");
  expect(readProjectReleaseSync(selected.directory)?.buildId).toBe(release.buildId);
  expect(await readFile(path.join(release.directory, "steamharness.json"), "utf8")).toBe(initial);
  await expect(prepareReleaseRun(directory, { entryId: "missing" })).rejects.toThrow(/not included/);
});
it("rejects release assets that expose source or escape the project", async () => {
  const { directory, declaration } = await fixture();
  await writeFile(path.join(directory, "steamharness.json"), JSON.stringify({ ...declaration, release: { files: ["index.ts"] } }));
  await expect(buildProjectRelease(directory)).rejects.toThrow(/Forbidden release/);
  await writeFile(path.join(directory, "steamharness.json"), JSON.stringify({ ...declaration, release: { files: ["../secret"] } }));
  await expect(buildProjectRelease(directory)).rejects.toThrow(/Invalid release path/);
});

it("isolates configuration state between source and release and retains it across rebuilds", async () => {
  const { directory, declaration } = await fixture();
  declaration.entries[0] = { ...declaration.entries[0], configuration: "configuration.json" } as any;
  await writeFile(path.join(directory, "steamharness.json"), JSON.stringify(declaration));
  await writeFile(path.join(directory, "configuration.json"), JSON.stringify({ version: 1, fields: [{ name: "label", type: "string" }] }));
  const release = await buildProjectRelease(directory);
  const rootDir = path.join(os.homedir(), "configurations");
  const dataRoot = path.join(os.homedir(), "web");
  expect(projectDataDirectorySync(dataRoot, release.directory, id, "main")).toBe(path.join(dataRoot, "release/projects", id, "entries/main"));
  expect(projectDataDirectorySync(dataRoot, directory, id, "main")).toBe(path.join(dataRoot, "projects", id, "entries/main"));
  const source = await createLocalProjectConfigurationStore(directory, { rootDir });
  const compiled = await createLocalProjectConfigurationStore(release.directory, { rootDir });
  const state = await source.read();
  await source.dispatch({ action: "save", revision: state.revision, id: state.activeConfigurationId, values: { label: "development" } });
  const released = await compiled.read();
  expect(released.configurations[0].values.label).toBeUndefined();
  await compiled.dispatch({ action: "save", revision: released.revision, id: released.activeConfigurationId, values: { label: "release" } });
  await writeFile(path.join(directory, "index.ts"), sourceFileWithComment());
  await buildProjectRelease(directory);
  expect((await compiled.snapshot()).values.label).toBe("release");
  expect((await source.snapshot()).values.label).toBe("development");
});
function sourceFileWithComment() { return source + "\n// next build\n"; }

it("keeps configured Agent model ownership after identifier minification", async () => {
  const { directory, declaration } = await fixture();
  declaration.entries[0].type = "bot";
  await writeFile(path.join(directory, "steamharness.json"), JSON.stringify(declaration));
  await writeFile(path.join(directory, "index.ts"), `const steamharness=globalThis.steamharness;
export const executor=steamharness.defineBot({name:'release-agent',agent:{modelSource:'project'}});`);
  const release = await buildProjectRelease(directory);
  expect(projectUsesConfiguredAgentModels(path.join(release.directory, "entries/main"), path.join(release.directory, "entries/main/index.mjs"), release.directory)).toBe(true);
  await withUserSettings({ agent: { permissionPolicy: "auto", models: [] } }, async () => {
    expect(readProjectConfigurationDefinition(release.directory, "main").fields.some(field => field.control === "ai-models")).toBe(true);
  });
});

it("releases multiple roots and shared roots and serves detached Kanban HTML, CSS and dynamic JS", async () => {
  const { directory, declaration } = await fixture();
  await mkdir(path.join(directory, "apps/board"), { recursive: true });
  await writeFile(path.join(directory, "apps/board/steamharness.json"), JSON.stringify({ name: "Board", type: "kanban", databases: [] }));
  const buildScript = `import{mkdir,writeFile}from'node:fs/promises';const root='dist/steamharness/entries/apps%2Fboard/build/board';await mkdir(root,{recursive:true});for(const [name,content]of Object.entries({'index.html':'<html><head><link rel="stylesheet" href="style.css"></head><body><script type="module" src="main.js"></script></body></html>','style.css':'body { color: red; }','main.js':'import("./dynamic.js").then(value=>document.body.textContent=value.answer)','dynamic.js':'export const answer="loaded"'}))await writeFile(root+'/'+name,content);`;
  await writeFile(path.join(directory, "build.mjs"), buildScript);
  await writeFile(path.join(directory, "steamharness.json"), JSON.stringify({ ...declaration, entries: [...declaration.entries, { ...declaration.entries[0], entryId: "alias" }, { entryId: "board", root: "apps/board" }], release: { build: [process.execPath, "build.mjs"] } }));
  const release = await buildProjectRelease(directory);
  expect(release.entries).toEqual(["main", "alias", "board"]);
  const detached = await mkdtemp(path.join(os.tmpdir(), "detached-release-")); folders.push(detached);
  await cp(release.directory, detached, { recursive: true });
  await mkdir(path.join(detached, "node_modules/@steamharness"), { recursive: true });
  await symlink(path.resolve("../harness"), path.join(detached, "node_modules/steamharness"), "dir");
  await symlink(path.resolve("."), path.join(detached, "node_modules/@steamharness/cli"), "dir");
  const app = await startWebServer({ projectDir: detached, entryId: "board", dataDir: path.join(os.homedir(), "web") });
  try {
    const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get("session");
    const response = await fetch(`${app.origin}/entries/board/api/message`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ type: "ready" }) });
    const ready = await response.json();
    expect(response.status, JSON.stringify(ready)).toBe(200);
    const preview = ready.messages[0].kanban.preview.url;
    const base = new URL(preview, `${app.origin}/entries/board/`);
    const html = await fetch(base); expect(html.status).toBe(200); expect(await html.text()).toContain('src="main.js"');
    for (const [asset, mime] of [["main.js", "javascript"], ["dynamic.js", "javascript"], ["style.css", "css"]]) {
      const result = await fetch(new URL(asset, base)); expect(result.status).toBe(200); expect(result.headers.get("content-type")).toContain(mime);
    }
    expect((await fetch(new URL("structure.json", base))).status).toBe(404);
    expect((await fetch(new URL("steamharness.json", base))).status).toBe(404);
  } finally { await app.close(); }
});


it('cancels a release command, keeps the last complete build and releases its lock', async () => {
  const { directory, declaration } = await fixture();
  const first = await buildProjectRelease(directory);
  await writeFile(path.join(directory, 'wait.mjs'), 'console.log("release-test-started");setInterval(()=>{},1000);');
  await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify({ ...declaration, release: { build: [process.execPath, 'wait.mjs'] } }));
  const controller = new AbortController();
  await expect(buildProjectRelease(directory, { signal: controller.signal, progress: message => { if (message.includes('release-test-started')) controller.abort(); } })).rejects.toThrow();
  expect(readProjectReleaseSync(first.directory)?.buildId).toBe(first.buildId);
  await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify(declaration));
  expect((await buildProjectRelease(directory)).entries).toEqual(['main']);
});

it('refuses a missing release manifest instead of treating the distribution as source', async () => {
  const { directory } = await fixture();
  const result = await buildProjectRelease(directory);
  await rm(path.join(result.directory, 'steamharness.release.json'));
  await expect(createProjectUploadPlan(result.directory)).rejects.toThrow(/manifest is missing/);
});


it('rejects source-local runtime storage before preparing a release run', async () => {
  const { directory } = await fixture();
  await expect(runWebCommand([directory, '--release', '--no-open', '--data-dir', path.join(directory, 'runtime')])).rejects.toThrow(/outside the project/);
});
