// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { readProjectReleaseSync, readReleaseStructureSync, releaseHash, sealProjectRelease } from "../release-node";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const projectId = "72e34bc3-7bbd-4d45-b38b-f941ff856424";
const manifest = { kind: "steamharness.project.release" as const, version: 1 as const, projectId, projectVersion: "1.0.0", buildId: "1".repeat(64), inputHash: "2".repeat(64),
  entries: [{ entryId: "main", root: "entries/main", entry: "index.mjs", configuration: "configuration.json", structure: "entries/main/structure.json" }] };
const structure = { version: 1, report: { projectId, entryId: "main", entryName: "Main entry", projectType: "workflow", definitions: { nodes: { internal: { prompt: "PRIVATE STRUCTURE DETAILS" } } }, diagnostics: { violations: [], warnings: [] } }, scripts: { definedNodes: [], violations: [] }, agentModels: { found: true, projectModels: true } };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-json-")); directories.push(root);
  const documents = {
    "steamharness.json": { id: projectId, name: "Release project", version: "1.0.0", defaultEntry: "main", entries: [{ entryId: "main", root: "entries/main" }] },
    "package.json": { name: "release-project", version: "1.0.0", type: "module" },
    "entries/main/steamharness.json": { name: "Main entry", type: "workflow", entry: "index.mjs", configuration: "configuration.json", databases: [] },
    "entries/main/configuration.json": { version: 1, fields: [{ name: "prompt", type: "string", defaultValue: "Keep  spaces\nand newlines" }] },
    "entries/main/structure.json": structure,
  };
  for (const [relative, value] of Object.entries(documents)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), JSON.stringify(value, null, 2) + "\n");
  }
  await writeFile(path.join(root, "entries/main/index.mjs"), 'throw new Error("Sealing must not execute project code");');
  return { root, documents };
}

it("encodes internal structure before hashing and keeps project, entry and configuration metadata readable", async () => {
  const { root, documents } = await fixture();
  const sealed = sealProjectRelease(root, manifest);
  for (const [relative, value] of Object.entries(documents)) {
    const text = await readFile(path.join(root, relative), "utf8");
    if (relative.endsWith("/structure.json")) {
      expect(JSON.parse(text)).toMatchObject({ version: 2, encoding: "brotli-base64", projectId, entryId: "main", entryName: "Main entry", projectType: "workflow" });
      expect(text).not.toContain("PRIVATE STRUCTURE DETAILS");
      expect(text).not.toContain('"definitions"');
      expect(JSON.parse(text).report).toBeUndefined();
      expect(text).not.toMatch(/[\r\n]/);
    } else {
      expect(text).toBe(JSON.stringify(relative === "steamharness.json" ? { ...value, distribution: { kind: "release", version: 1 } } : value));
    }
    const file = sealed.files.find(file => file.path === relative)!;
    expect(file).toMatchObject({ size: Buffer.byteLength(text), sha256: releaseHash(text) });
  }
  expect(await readFile(path.join(root, "steamharness.release.json"), "utf8")).toBe(JSON.stringify(sealed));
  expect(readProjectReleaseSync(root)).toEqual(sealed);
  expect(readReleaseStructureSync(root, "main")).toEqual(structure);
  const before = await readFile(path.join(root, "steamharness.release.json"), "utf8");
  sealProjectRelease(root, manifest);
  expect(await readFile(path.join(root, "steamharness.release.json"), "utf8")).toBe(before);
});

it("preserves asset number literals, escaped characters and meaningful whitespace inside strings", async () => {
  const { root } = await fixture();
  const asset = String.raw`{
  "large": 9007199254740993,
  "negativeZero": -0,
  "exponent": 1.2500e+4,
  "text": " 中文  spaces \t tab \r\n newline \"quote\" \\ slash \u0061",
  "items": [ 1, { "label": " keep " } ]
}`.replaceAll("\n", "\r\n");
  await writeFile(path.join(root, "asset.JSON"), asset);
  sealProjectRelease(root, manifest);
  const compact = await readFile(path.join(root, "asset.JSON"), "utf8");
  expect(compact).not.toMatch(/[\r\n]/);
  expect(compact).toContain('"large":9007199254740993,"negativeZero":-0,"exponent":1.2500e+4');
  expect(compact).toContain(String.raw`"text":" 中文  spaces \t tab \r\n newline \"quote\" \\ slash \u0061"`);
  expect(JSON.parse(compact)).toEqual(JSON.parse(asset));
});

it("recompacts Server-style published templates and attachments before renewing the release inventory", async () => {
  const { root } = await fixture();
  sealProjectRelease(root, manifest);
  await mkdir(path.join(root, "configuration-templates"));
  const template = { version: 1, values: { prompt: "Keep this\n\nformatted text" } };
  await writeFile(path.join(root, "configuration-templates/main.json"), JSON.stringify(template, null, 2));
  const sealed = sealProjectRelease(root, manifest);
  expect(await readFile(path.join(root, "configuration-templates/main.json"), "utf8")).toBe(JSON.stringify(template));
  expect(readProjectReleaseSync(root)?.files).toEqual(sealed.files);
});

it.each([Buffer.from('{"broken": }'), Buffer.from([0x22, 0xff, 0x22])])("rejects invalid JSON or UTF-8 assets with their relative path", async bytes => {
  const { root } = await fixture();
  await writeFile(path.join(root, "invalid.json"), bytes);
  expect(() => sealProjectRelease(root, manifest)).toThrow("Invalid release JSON: invalid.json");
});

async function replaceStructure(root: string, content: object) {
  const bytes = JSON.stringify(content);
  await writeFile(path.join(root, "entries/main/structure.json"), bytes);
  const release = JSON.parse(await readFile(path.join(root, "steamharness.release.json"), "utf8"));
  Object.assign(release.files.find((file: { path: string }) => file.path === "entries/main/structure.json"), { size: Buffer.byteLength(bytes), sha256: releaseHash(bytes) });
  await writeFile(path.join(root, "steamharness.release.json"), JSON.stringify(release));
}

it.each([
  { data: "!invalid-base64!" }, { data: Buffer.from("not Brotli").toString("base64") },
  { entryId: "other" }, { projectId: "other" }, { entryName: "other" }, { projectType: "bot" }, { unexpected: true },
  { data: brotliCompressSync(Buffer.from([0xff])).toString("base64") },
])("rejects corrupted or inconsistent structure payloads even with a renewed file checksum: %j", async change => {
  const { root } = await fixture();
  sealProjectRelease(root, manifest);
  const encoded = JSON.parse(await readFile(path.join(root, "entries/main/structure.json"), "utf8"));
  await replaceStructure(root, { ...encoded, ...change });
  expect(() => readProjectReleaseSync(root)).toThrow("Invalid release structure: main");
});

it.each([{ version: 3 }, { encoding: "unknown" }])("requires a matching host for unknown structure formats: %j", async change => {
  const { root } = await fixture();
  sealProjectRelease(root, manifest);
  const encoded = JSON.parse(await readFile(path.join(root, "entries/main/structure.json"), "utf8"));
  await replaceStructure(root, { ...encoded, ...change });
  expect(() => readProjectReleaseSync(root)).toThrow(/Unsupported release structure format.*Upgrade the host/);
});

it("rejects unencoded release structures instead of falling back to the previous format", async () => {
  const { root } = await fixture();
  sealProjectRelease(root, manifest);
  await replaceStructure(root, structure);
  expect(() => readProjectReleaseSync(root)).toThrow(/Unsupported release structure format/);
});

it("limits decompression of untrusted uploaded structure payloads", async () => {
  const { root } = await fixture();
  sealProjectRelease(root, manifest);
  const encoded = JSON.parse(await readFile(path.join(root, "entries/main/structure.json"), "utf8"));
  const data = brotliCompressSync(Buffer.alloc(64 * 1024 * 1024 + 1, 32), { params: { [constants.BROTLI_PARAM_QUALITY]: 0 } }).toString("base64");
  await replaceStructure(root, { ...encoded, data });
  try { readProjectReleaseSync(root); expect.fail("Oversized payload must be rejected before parsing"); }
  catch (error) { expect((error as Error).cause).toMatchObject({ code: "ERR_BUFFER_TOO_LARGE" }); }
});
