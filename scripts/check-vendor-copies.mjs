import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 共享脚本副本守卫（vendor + 内置项目）。
 *
 * 同一仓库里有两类逐字节副本，任何一份漂移都会让某个消费方比别的弱，而那种差异在
 * review 里几乎看不出来：
 *
 *   shared/release-tools/*        -> harness|cli|server 的 vendor/shared/release-tools/*
 *                                 -> build-in 三个内置项目的 scripts/
 *   build-in-developer-assistant/scripts/*  -> 另外两个内置项目的 scripts/
 *
 * 内置项目之间还有一处有意的不一致：`builtin-release.mjs` 在 developer-assistant 里
 * 多一段打包过滤（它要把 skill 的 `scripts/create_workflow.py` 一起打进制品），因此它
 * 不在守卫范围内。
 *
 * vendor 侧不只镜像 release-tools：harness/cli/server 的 `vendor/shared/` 是整个 shared
 * 树的逐字节副本，任何一个包改了都要同步过去，否则消费方会跑在旧代码上。共享包里不放
 * `__tests__`、`node_modules` 与 `.agents`/`.codex` 这类仓库自有内容。
 */

export const VENDOR_CONSUMERS = Object.freeze(["harness", "cli", "server"]);

export const BUILTIN_PROJECTS = Object.freeze([
  "build-in/build-in-developer-assistant",
  "build-in/build-in-studio-control",
  "build-in/build-in-analysis",
]);

/** `shared` 下的这些目录不是包，不参与 vendor 镜像。 */
export const SHARED_EXCLUDED_ENTRIES = Object.freeze([
  "node_modules", "scripts", "tests", "__tests__", ".agents", ".codex", ".claude",
  "dist", "coverage", ".release",
]);

/** `shared` 真相源里被内置项目以单文件方式复制的脚本。 */
export const BUILTIN_SHARED_FILES = Object.freeze([
  Object.freeze({ source: "shared/release-tools/release-gate.mjs", file: "release-gate.mjs" }),
  Object.freeze({ source: "shared/release-tools/release-notes.mjs", file: "release-notes.mjs" }),
]);

/** 只在内置项目之间共享、以 developer-assistant 为规范副本的脚本。 */
export const BUILTIN_ONLY_COPIES = Object.freeze([
  Object.freeze({ file: "prepare-local-siblings.mjs" }),
  Object.freeze({ file: "prepare-release.mjs" }),
  Object.freeze({ file: "__tests__/prepare-local-siblings.test.mjs" }),
]);

const BUILTIN_CANONICAL = BUILTIN_PROJECTS[0];

export function hashContent(content) {
  // Windows checkout 的 CRLF 与结尾换行会造成假漂移。
  return createHash("sha256").update(String(content).replace(/\r\n/gu, "\n").replace(/\n+$/u, "\n")).digest("hex");
}

async function readHash(absolutePath) {
  try {
    return hashContent(await readFile(absolutePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function exists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/** 测试与依赖目录不参与 vendor 镜像，在任意层级都排除。 */
const VENDOR_EXCLUDED_SEGMENTS = new Set(["__tests__", "node_modules"]);

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (VENDOR_EXCLUDED_SEGMENTS.has(entry.name)) { continue; }
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path.join(directory, entry.name), relative));
      continue;
    }
    files.push(relative);
  }
  return files.sort();
}

/** 期望的逐字节副本清单：[{ copy, source, file }]，copy 为仓库相对的目标路径。 */
export async function expectedCopies(root, options = {}) {
  const consumers = options.consumers ?? VENDOR_CONSUMERS;
  const projects = options.projects ?? BUILTIN_PROJECTS;
  const copies = [];
  const sharedRoot = path.join(root, "shared");
  const packages = (await readdir(sharedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !SHARED_EXCLUDED_ENTRIES.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const consumer of consumers) {
    for (const packageName of packages) {
      const sourceDirectory = path.join(sharedRoot, packageName);
      for (const file of await collectFiles(sourceDirectory)) {
        copies.push({
          copy: `${consumer}/vendor/shared/${packageName}/${file}`,
          source: `shared/${packageName}/${file}`,
        });
      }
    }
  }
  for (const shared of BUILTIN_SHARED_FILES) {
    for (const project of projects) copies.push({ copy: `${project}/scripts/${shared.file}`, source: shared.source });
  }
  for (const only of BUILTIN_ONLY_COPIES) {
    for (const project of projects) {
      copies.push({ copy: `${project}/scripts/${only.file}`, source: `${BUILTIN_CANONICAL}/scripts/${only.file}` });
    }
  }
  return copies;
}

export async function checkVendorCopies(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const drift = [];
  const copies = await expectedCopies(absoluteRoot, options);
  for (const copy of copies) {
    const sourceHash = await readHash(path.join(absoluteRoot, copy.source));
    if (sourceHash === undefined) {
      drift.push({ copy: copy.copy, source: copy.source, kind: "source-missing" });
      continue;
    }
    const targetHash = await readHash(path.join(absoluteRoot, copy.copy));
    if (targetHash === sourceHash) continue;
    drift.push({ copy: copy.copy, source: copy.source, kind: targetHash === undefined ? "missing" : "different" });
  }
  return { drift, copies };
}

export async function syncVendorCopies(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const written = [];
  const copies = await expectedCopies(absoluteRoot, options);
  for (const copy of copies) {
    const sourcePath = path.join(absoluteRoot, copy.source);
    if (!await exists(sourcePath)) continue;
    const targetPath = path.join(absoluteRoot, copy.copy);
    if (path.resolve(targetPath) === path.resolve(sourcePath)) continue;
    if (await exists(targetPath) && await readHash(targetPath) === await readHash(sourcePath)) continue;
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath);
    written.push(copy.copy);
  }
  return written;
}

/** vendor 目录里多出来的文件也按漂移报出，避免副本悄悄长出新文件。 */
export async function checkVendorExtras(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const extras = [];
  const expected = new Set((await expectedCopies(absoluteRoot, options)).map((copy) => copy.copy));
  for (const consumer of options.consumers ?? VENDOR_CONSUMERS) {
    const targetDirectory = path.join(absoluteRoot, `${consumer}/vendor/shared/release-tools`);
    if (!await exists(targetDirectory)) continue;
    for (const file of await collectFiles(targetDirectory)) {
      const copy = `${consumer}/vendor/shared/release-tools/${file}`;
      if (!expected.has(copy)) extras.push(copy);
    }
  }
  return extras;
}

export function formatVendorCopyDrift(drift, copies) {
  return [
    "Shared scripts drifted from their source:",
    ...drift.map((entry) => `- ${entry.copy} is ${entry.kind} (source: ${entry.source})`),
    `Run \`node scripts/check-vendor-copies.mjs --fix\` and commit the synced copies (${copies.length} tracked files).`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = { fix: false };
  for (const token of argv) {
    if (token === "--fix") {
      options.fix = true;
      continue;
    }
    if (token === "--check" || token === "--") continue;
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "..");
  if (options.fix) {
    const written = await syncVendorCopies(root);
    process.stdout.write(`Synced ${written.length} script copies.\n`);
  }
  const { drift, copies } = await checkVendorCopies(root);
  if (drift.length > 0) throw new Error(formatVendorCopyDrift(drift, copies));
  const extras = await checkVendorExtras(root);
  if (extras.length > 0) {
    throw new Error(`Vendor directories carry files without a shared source:\n- ${extras.join("\n- ")}\n`);
  }
  process.stdout.write(`Shared scripts are in sync (${copies.length} tracked files).\n`);
}
