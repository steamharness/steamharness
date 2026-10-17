import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 发布态引用门禁。
 *
 * `dev` 与功能分支上，内置项目和 `cli` 用 `link:../core` 这类本地相对路径引用同级
 * 仓库，这样改 Core/CLI 不需要先发版再改 pin。`alpha` 与 `main` 是发布通道，清单里
 * 必须写精确的已发布版本。这个模块把"当前是哪种模式"、"这个引用解析成哪个版本"
 * 以及发布前必须成立的四项检查放在一起，供发布脚本、各仓 CI 与聚合仓库共用。
 *
 * 它必须保持零运行时依赖：`shared/release-tools/` 会被 vendor 到 core / cli /
 * server 的 `vendor/shared/`，也会被逐字节复制到 3 个内置项目的
 * `scripts/`。任何 import 都会在某一侧缺失。
 */

export const SUPPORTED_PACKAGES = Object.freeze(["steamharness", "@steamharness/cli"]);

/**
 * 消费方可能把 Core / CLI 写在哪个依赖段里。
 *
 * 内置项目放 `devDependencies`，Server 放 `dependencies`；门禁必须按
 * 清单实际写的位置去读，否则"检查通过"只说明它没找到该检查的东西。
 */
export const CONSUMER_SECTIONS = Object.freeze(["dependencies", "devDependencies"]);

/** 精确 SemVer：`X.Y.Z` 或 `X.Y.Z-预发布`。拒绝区间、tag 前缀与 `workspace:`。 */
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** 特性分支版本：`X.Y.Z-YYYYMMDDNNN.<分支 slug>`，由 `pnpm release:feature` 生成。 */
export const FEATURE_VERSION_PATTERN = /^\d+\.\d+\.\d+-\d{11}\.[a-z0-9][a-z0-9.-]*$/u;

/** 日期版本：`X.Y.Z-YYYYMMDDNNN`，Alpha / Dev 通道由 tag 账本分配。 */
export const DATED_VERSION_PATTERN = /^\d+\.\d+\.\d+-\d{11}$/u;

const LOCAL_SPECIFIER_PATTERN = /^(?:file|link):(.*)$/u;

/**
 * 当前处于开发模式还是发布模式。
 *
 * 刻意不复用 Server / CLI 的 `resolveRepositoryMode()`：那里的 `alpha` 算
 * "非 main"，而这里是发布通道，必须按发布模式处理。两者回答的是不同的问题。
 */
export function resolveReleaseMode({ env = process.env, branch, tag, runGit = runGitCommand, root } = {}) {
  const override = String(env.STEAMHARNESS_REPOSITORY_MODE ?? "").trim();
  if (override !== "" && override !== "main") {
    throw new Error("STEAMHARNESS_REPOSITORY_MODE only accepts main as a fail-closed override.");
  }
  if (override === "main") return "main";
  if (firstText(tag, env.CI_COMMIT_TAG) !== undefined) return "main";

  const resolved = firstText(
    branch,
    env.CI_COMMIT_BRANCH,
    env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME,
  ) ?? readGitBranch(root, runGit);
  return resolved === "main" || resolved === "alpha" ? "main" : "dev";
}

const FEATURE_TAG_PATTERN = /^feat\/v(\d+\.\d+\.\d+-\d{11}\.([a-z0-9][a-z0-9.-]*))$/u;

/** 发布到哪个 npm dist-tag。与 `alpha-release.mjs` / `feature-release.mjs` 的通道定义保持一致。 */
export function resolveReleaseChannel({ env = process.env, branch, tag, runGit = runGitCommand, root } = {}) {
  const resolvedTag = firstText(tag, env.CI_COMMIT_TAG) ?? "";
  const feature = FEATURE_TAG_PATTERN.exec(resolvedTag);
  if (feature !== null) return `feat-${feature[2]}`.slice(0, 60);
  if (resolvedTag !== "") return "latest";

  const resolved = firstText(branch, env.CI_COMMIT_BRANCH, env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME)
    ?? readGitBranch(root, runGit);
  if (resolved === "alpha") return "alpha";
  if (resolved === "dev") return "dev";
  return "latest";
}

/**
 * 纯分类，不碰文件系统。
 *
 * @returns {{kind: "exact", version: string, specifier: string}
 *         | {kind: "local", specifier: string, relative: string}}
 */
export function classifyVersionReference(manifest, packageName, { section = "devDependencies" } = {}) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("Workflow package.json root must be an object.");
  }
  const dependencies = manifest[section];
  const label = `${section}.${packageName}`;
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    throw new Error(`Workflow package.json must declare ${label} as an exact version.`);
  }
  const value = dependencies[packageName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Workflow package.json must declare ${label} as an exact version.`);
  }

  const specifier = value.trim();
  const local = LOCAL_SPECIFIER_PATTERN.exec(specifier);
  if (local !== null) {
    const relative = local[1];
    // 只有相对形式才可能指向同级检出。绝对路径、`file:core` 这种没有 `./` / `../`
    // 前缀的写法，以及 `workspace:*` 一律不接受。
    if (!relative.startsWith("./") && !relative.startsWith("../")) {
      throw new Error(`${label} must use a relative file:/link: specifier, received ${specifier}.`);
    }
    return { kind: "local", specifier, relative };
  }
  if (!EXACT_VERSION_PATTERN.test(specifier)) {
    throw new Error(`${label} "${value}" must be an exact SemVer version.`);
  }
  return { kind: "exact", version: specifier, specifier };
}

/**
 * 把一个引用解析成具体版本。发布模式下相对路径直接失败；开发模式下读取同级
 * `package.json` 的 `version`。
 *
 * 同级解析的边界是 `workspaceRoot`（默认取声明仓库的父目录）——`link:../core` 必须
 * 逃出声明它的仓库才能成立，所以边界不能是仓库自身。边界检查在 `realpath` 之后再
 * 做一遍，`link:../core` 指向仓外符号链接的写法同样会被拦下。
 */
export async function resolveVersionReference(manifest, packageName, options) {
  const {
    mode,
    repoRoot,
    workspaceRoot = path.dirname(path.resolve(repoRoot)),
    section = "devDependencies",
    readFileImpl = readFile,
    realpathImpl = realpath,
  } = options ?? {};
  if (mode !== "dev" && mode !== "main") throw new Error(`Unsupported release mode: ${String(mode)}`);

  const reference = classifyVersionReference(manifest, packageName, { section });
  if (reference.kind === "exact") {
    return { version: reference.version, origin: "declared", specifier: reference.specifier };
  }
  if (mode === "main") {
    throw new Error(
      `${section}.${packageName} must declare an exact published version on main and alpha; `
      + `${reference.specifier} is only allowed on dev and feature branches.`,
    );
  }

  const absoluteRepoRoot = path.resolve(repoRoot);
  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);
  const target = path.resolve(absoluteRepoRoot, reference.relative);
  assertInsideWorkspace(target, absoluteWorkspaceRoot, reference.specifier);
  if (target === absoluteRepoRoot || isAncestor(target, absoluteRepoRoot)) {
    throw new Error(`${reference.specifier} must point at a sibling repository, not the repository itself.`);
  }
  // 边界检查要在 realpath 之后再做一遍：`link:../core` 可以是一个指向仓外的符号链接。
  const realWorkspaceRoot = await realpathImpl(absoluteWorkspaceRoot).catch(() => absoluteWorkspaceRoot);
  const realTarget = await realpathImpl(target).catch(() => {
    throw new Error(`${reference.specifier} does not resolve to an existing sibling repository (${target}).`);
  });
  assertInsideWorkspace(realTarget, realWorkspaceRoot, reference.specifier);

  let sibling;
  try {
    sibling = JSON.parse(await readFileImpl(path.join(realTarget, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`${reference.specifier} does not contain a readable package.json: ${formatError(error)}`);
  }
  if (sibling?.name !== packageName) {
    throw new Error(`${reference.specifier} declares ${String(sibling?.name ?? "no package name")}, expected ${packageName}.`);
  }
  const version = String(sibling.version ?? "").trim();
  if (!EXACT_VERSION_PATTERN.test(version)) {
    throw new Error(`${reference.specifier} declares an invalid version: ${String(sibling.version ?? "")}.`);
  }
  return { version, origin: "sibling", specifier: reference.specifier, target: realTarget };
}

/**
 * 找出这个包在清单里被声明的每一个依赖段。
 *
 * 一个都没声明是错误：门禁最容易骗人的失败方式是"没找到就通过"。默认只看消费方
 * 真正会用的两段，要更窄的范围时由调用方给出。
 *
 * @returns {{section: string, reference: object}[]}
 */
export function findVersionReferences(manifest, packageName, { sections = CONSUMER_SECTIONS } = {}) {
  const found = [];
  for (const section of sections) {
    const dependencies = manifest?.[section];
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) continue;
    if (dependencies[packageName] === undefined) continue;
    found.push({ section, reference: classifyVersionReference(manifest, packageName, { section }) });
  }
  if (found.length === 0) {
    throw new Error(`${packageName} must be declared in ${sections.join(" or ")}.`);
  }
  return found;
}

/** 检查 (a)：发布通道上不得出现本地相对引用。 */
export function assertNoLocalReference(manifest, packageName, { mode, section = "devDependencies" } = {}) {
  const reference = classifyVersionReference(manifest, packageName, { section });
  if (reference.kind === "local" && mode === "main") {
    throw new Error(
      `${section}.${packageName} must declare an exact published version on main and alpha; `
      + `${reference.specifier} is only allowed on dev and feature branches.`,
    );
  }
  return reference;
}

/** 检查 (b)：特性分支版本永不复用、永不转正，因此发布通道上不得声明它。 */
export function assertChannelVersion(packageName, version, { channel } = {}) {
  if (FEATURE_VERSION_PATTERN.test(String(version).trim())) {
    throw new Error(
      `${packageName} ${version} is a feature-branch version and cannot be released on the ${String(channel ?? "release")} channel; `
      + "pin a channel version instead.",
    );
  }
}

/**
 * 检查 (c)：声明的版本必须在 registry 上真实存在。
 *
 * 读回窗口要能覆盖 npm 的异步发布处理：消费方流水线可能在发布作业完成后不久
 * 就启动，版本这时可能还处于 "being processed"，读回会短暂 404。
 */
export async function assertPublishedVersion(packageName, version, options = {}) {
  const { runCommand = runNpm, attempts = 8, retryDelayMs = 8000, sleep = delay } = options;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const output = runCommand(["view", `${packageName}@${version}`, "version", "--json"]);
      if (String(output).includes(version)) return;
      lastError = new Error(`${packageName}@${version} read back as ${String(output).trim()}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  throw new Error(`${packageName}@${version} is not published: ${formatError(lastError)}`);
}

/**
 * 版本必须高于该通道当前 dist-tag 指向的版本。
 *
 * 这是**发布者**一侧的检查：只有正在发布的那个包才谈得上"前进"。消费方清单里的
 * 是一个已经存在的依赖版本，转正时它恰好等于通道当前版本，要求递增会必然失败。
 */
export async function assertVersionAdvance(packageName, version, options = {}) {
  const { runCommand = runNpm, distTag = "latest" } = options;
  let current = "";
  try {
    current = String(runCommand(["view", `${packageName}`, `dist-tags.${distTag}`, "--json"])).trim();
  } catch {
    // 该通道还没有任何发布：任何版本都是前进。
    return { current: undefined };
  }
  const published = current.replaceAll('"', "").trim();
  if (published === "") return { current: undefined };
  const comparison = compareVersions(version, published);
  if (comparison <= 0) {
    throw new Error(
      `${packageName} ${version} must be higher than the ${distTag} channel's current ${published}.`,
    );
  }
  return { current: published };
}

/**
 * 对一份清单跑完整门禁：(a) 本地相对引用、(b) 特性分支版本、(c) registry 读回。
 * 发布通道上三项都跑；开发模式只跑 (a)。
 *
 * 这里**不**检查版本递增：这是消费方一侧，声明的是"我要用的依赖版本"，转正时它
 * 正好等于通道当前版本。递增只在发布者一侧成立，见 `verifyPublisherGate`。
 */
export async function verifyReleaseGate(options) {
  const {
    manifest,
    packageNames = SUPPORTED_PACKAGES,
    mode,
    channel = "latest",
    sections = CONSUMER_SECTIONS,
    runCommand,
    attempts,
    retryDelayMs,
  } = options;
  const results = [];
  for (const packageName of packageNames) {
    // 每一处声明都要查：同一个包同时出现在 dependencies 和 devDependencies
    // 时，只查其中一段等于放过另一段。
    for (const { section } of findVersionReferences(manifest, packageName, { sections })) {
      const reference = assertNoLocalReference(manifest, packageName, { mode, section });
      if (reference.kind !== "exact") {
        results.push({ packageName, section, version: undefined, checked: false });
        continue;
      }
      assertChannelVersion(packageName, reference.version, { channel });
      await assertPublishedVersion(packageName, reference.version, { runCommand, attempts, retryDelayMs });
      results.push({ packageName, section, version: reference.version, checked: true });
    }
  }
  return { mode, channel, packages: results };
}

/**
 * 每个包可能出现在多个依赖段里，键里带上段名，两个位置不会互相覆盖。
 */
export function formatReleaseGateDotenv(report) {
  const lines = ["STEAMHARNESS_RELEASE_GATE_OK=true", `STEAMHARNESS_RELEASE_GATE_CHANNEL=${report.channel}`];
  for (const entry of report.packages) {
    const prefix = `STEAMHARNESS_RELEASE_GATE_${entry.packageName.replace(/^@/u, "").replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}`;
    const section = String(entry.section ?? "").replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
    lines.push(`${prefix}${section === "" ? "" : `_${section}`}_VERSION=${entry.version ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 发布者一侧的门禁：即将发布的版本必须还没发布过；稳定版还必须高于该通道当前
 * 版本。与 `verifyReleaseGate` 方向相反 —— 那里校验的是"我要用的版本存在"。
 */
export async function verifyPublisherGate(options) {
  const {
    manifest,
    packageName,
    channel = "latest",
    runCommand = runNpm,
  } = options;
  const version = String(manifest?.version ?? "").trim();
  if (!EXACT_VERSION_PATTERN.test(version)) {
    throw new Error(`${String(packageName)} package.json version "${String(manifest?.version ?? "")}" must be an exact SemVer version.`);
  }
  let alreadyPublished = false;
  try {
    const output = String(runCommand(["view", `${packageName}@${version}`, "version", "--json"]));
    alreadyPublished = output.includes(version);
  } catch {
    // A missing version is what a fresh release looks like.
  }
  // 日期版本由 tag 账本分配，同一个提交重跑流水线会保留同一个版本号，所以"已经
  // 发布过"是重跑的正常状态，不是重复发布。真正的护栏在 `npm-alpha-publish.mjs`：
  // 它会比对 registry 上的 tarball 完整性与本地产物，内容不同就直接报错。
  if (alreadyPublished && !DATED_VERSION_PATTERN.test(version)) {
    throw new Error(`${packageName}@${version} is already published; allocate a new version instead of republishing.`);
  }
  // 日期版本（Alpha/Dev）天然单调，只对稳定版要求高于当前 latest。
  const stable = !version.includes("-");
  if (stable && channel === "latest") {
    await assertVersionAdvance(packageName, version, { runCommand, distTag: "latest" });
  }
  return { packageName, version, channel };
}

function compareVersions(left, right) {
  const parse = (value) => String(value).split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [leftCore, rightCore] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) {
    if (leftCore[index] !== rightCore[index]) return leftCore[index] - rightCore[index];
  }
  return 0;
}

function assertInsideWorkspace(target, workspaceRoot, specifier) {
  const relative = path.relative(workspaceRoot, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${specifier} must stay inside the workspace root (${workspaceRoot}).`);
  }
}

function isAncestor(candidate, target) {
  const relative = path.relative(candidate, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readGitBranch(root, runGit) {
  try {
    return String(runGit(["branch", "--show-current"], root ?? process.cwd())).trim() || undefined;
  } catch {
    return undefined;
  }
}

function runGitCommand(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function runNpm(args) {
  return execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "")?.trim();
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  const options = { packages: [], manifests: ["package.json"], sections: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--package" && argv[index + 1]) {
      options.packages.push(argv[index + 1]);
      index += 1;
    } else if (token === "--section" && argv[index + 1]) {
      // 可重复：`--section dependencies --section devDependencies`。不给就按
      // 消费方常用的两段自动找。
      options.sections.push(argv[index + 1]);
      index += 1;
    } else if (token === "--manifest" && argv[index + 1]) {
      options.manifests.push(argv[index + 1]);
      index += 1;
    } else if (token === "--output" && argv[index + 1]) {
      options.output = argv[index + 1];
      index += 1;
    } else if (token === "--mode" && argv[index + 1]) {
      options.mode = argv[index + 1];
      index += 1;
    } else if (token === "--channel" && argv[index + 1]) {
      options.channel = argv[index + 1];
      index += 1;
    } else if (token === "publisher") {
      options.publisher = true;
    } else if (token !== "verify") {
      throw new Error(`Unknown or incomplete argument: ${token}`);
    }
  }
  options.manifests = [...new Set(options.manifests)];
  return options;
}

async function runCli(argv) {
  const options = parseArgs(argv);
  const root = path.resolve(options.root ?? process.cwd());
  const mode = options.mode ?? resolveReleaseMode({ root });
  const channel = options.channel ?? resolveReleaseChannel({ root });
  const reports = [];
  for (const manifestPath of options.manifests) {
    const manifest = JSON.parse(await readFile(path.join(root, manifestPath), "utf8"));
    if (options.publisher === true) {
      // 发布者模式作用于产物本身：清单的 `name` 就是要发布的包。
      for (const packageName of options.packages.length > 0 ? options.packages : [String(manifest.name ?? "")]) {
        if (packageName === "") throw new Error(`${manifestPath} declares no package name.`);
        await verifyPublisherGate({ manifest, packageName, channel });
      }
      continue;
    }
    reports.push(await verifyReleaseGate({
      manifest,
      packageNames: options.packages.length > 0 ? options.packages : SUPPORTED_PACKAGES,
      mode,
      channel,
      sections: options.sections.length > 0 ? options.sections : CONSUMER_SECTIONS,
    }));
  }
  if (options.output !== undefined) {
    await writeFile(path.join(root, options.output), reports.map(formatReleaseGateDotenv).join(""), "utf8");
  }
  for (const report of reports) {
    for (const entry of report.packages) {
      const where = entry.section === undefined ? "" : `${entry.section}.`;
      process.stdout.write(`${where}${entry.packageName}: ${entry.version ?? "(local reference)"}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[release-gate] ${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
