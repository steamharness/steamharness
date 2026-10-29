import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// steamharness-generator skill 的发布资源与 harness 开发副本在同一仓库的两个目录：
//   build-in/build-in-developer-assistant/skills/  —— 发布资源，运行时小助手真正加载的副本（唯一真相源）
//   harness/.agents/skills/                       —— harness 仓库开发时使用
// 两份必须各自提交，所以用这个脚本保证共享载荷不漂移。仓库特有文件不参与同步。

export const SKILL_RELATIVE_PATH = "skills/steamharness-generator";

export const SKILL_COPY_ROOTS = Object.freeze({
  source: "build-in/build-in-developer-assistant",
  targets: Object.freeze(["harness/.agents"]),
});

// 仓库特有文件：发版管辖权、Agent 提示词与降级修复流程按仓库不同，永不参与同步。
// 共享载荷用「排除」而不是「列举」：发布副本里新加的引用文件必须自动跟着两份副本走，
// 漏列一个就会让运行时读不到它（`references/runtime-api-index.md` 就这样漏过一次）。
export const SKILL_REPO_SPECIFIC_PATHS = Object.freeze([
  "AGENTS.md",
  "agents/openai.yaml",
  "references/project-repair.md",
]);

// 发布副本里不该出现、也不参与比较的东西。
const SKILL_IGNORED_NAMES = new Set([".DS_Store", "node_modules"]);

function isRepoSkillingPath(relative) {
  return SKILL_REPO_SPECIFIC_PATHS.includes(relative)
    || relative.split("/").some((segment) => SKILL_IGNORED_NAMES.has(segment));
}

export function skillCopyDirectory(copyRoot) {
  return path.join(copyRoot, SKILL_RELATIVE_PATH);
}

async function collectDirectoryFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectDirectoryFiles(absolute, relative));
      continue;
    }
    files.push({ relative, absolute });
  }
  return files;
}

export async function readSkillSharedFiles(copyRoot) {
  const skillDirectory = skillCopyDirectory(copyRoot);
  const files = new Map();
  for (const file of await collectDirectoryFiles(skillDirectory)) {
    if (isRepoSkillingPath(file.relative)) continue;
    files.set(file.relative, await readFile(file.absolute));
  }
  return files;
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function compareSkillCopies(sourceFiles, targetFiles) {
  const differences = [];
  for (const [relative, sourceContent] of sourceFiles) {
    const targetContent = targetFiles.get(relative);
    if (targetContent === undefined) {
      differences.push({ path: relative, kind: "missing" });
      continue;
    }
    if (hashContent(sourceContent) !== hashContent(targetContent)) {
      differences.push({ path: relative, kind: "different" });
    }
  }
  for (const relative of targetFiles.keys()) {
    if (!sourceFiles.has(relative)) differences.push({ path: relative, kind: "extra" });
  }
  return differences.sort((left, right) => left.path.localeCompare(right.path));
}

export async function checkSkillCopies(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const sourceRoot = path.join(root, SKILL_COPY_ROOTS.source);
  const sourceFiles = await readSkillSharedFiles(sourceRoot);
  const copies = [];
  for (const target of SKILL_COPY_ROOTS.targets) {
    const targetRoot = path.join(root, target);
    const differences = compareSkillCopies(sourceFiles, await readSkillSharedFiles(targetRoot));
    copies.push({ copy: target, root: targetRoot, differences });
  }
  return { sourceRoot, copies };
}

export async function syncSkillCopies(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const sharedFiles = await readSkillSharedFiles(path.join(root, SKILL_COPY_ROOTS.source));
  const copied = [];
  for (const target of SKILL_COPY_ROOTS.targets) {
    const targetRoot = path.join(root, target);
    const targetDirectory = skillCopyDirectory(targetRoot);
    // Whatever the copy carries that the payload does not is either a file to
    // remove (it was deleted at the source) or one of the repository-specific
    // paths above, which the walk never returns.
    for (const file of await collectDirectoryFiles(targetDirectory)) {
      if (isRepoSkillingPath(file.relative) || sharedFiles.has(file.relative)) continue;
      await rm(file.absolute, { force: true });
    }
    for (const [relative, content] of sharedFiles) {
      const targetPath = path.join(targetDirectory, relative);
      if (await pathExists(targetPath) && Buffer.compare(await readFile(targetPath), content) === 0) {
        continue;
      }
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
    }
    copied.push(target);
  }
  return { copied };
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export function formatSkillCopyDrift(result) {
  const lines = [];
  for (const copy of result.copies) {
    for (const difference of copy.differences) {
      lines.push(`${copy.copy}: ${difference.path} is ${difference.kind}`);
    }
  }
  return lines;
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
    const { copied } = await syncSkillCopies({ root });
    process.stdout.write(`Synced ${SKILL_RELATIVE_PATH} into ${copied.join(", ")}.\n`);
  } else {
    const result = await checkSkillCopies({ root });
    const drift = formatSkillCopyDrift(result);
    if (drift.length > 0) {
      throw new Error(
        `${SKILL_RELATIVE_PATH} copies drifted from ${SKILL_COPY_ROOTS.source}:\n- ${drift.join("\n- ")}\n`
        + `Run \`node scripts/check-skill-copies.mjs --fix\` and commit the synced copies.`,
      );
    }
    process.stdout.write(`${SKILL_RELATIVE_PATH} copies are in sync (${result.copies.length} copies).\n`);
  }
}
