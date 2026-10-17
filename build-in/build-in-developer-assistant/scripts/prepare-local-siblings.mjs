import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `dev` 和功能分支上，内置项目用 `link:../../harness` / `link:../../cli` 引用源码，
 * 所以在 monorepo 之外的检出里，`pnpm install` 之前必须按清单的相对路径准备同级目录。
 *
 * Alpha 和 `main` 上的依赖是精确的已发布版本，安装走 npm，不需要同级目录；但生成物
 * （`scripts/runtime-api-index.mjs` 读的是同级 harness 的**源码**）要在 CI 里校验，就必须
 * 把声明的那一版源码取到同样的位置：按版本找到它的发布 tag（`alpha/v…` / `dev/v…` / `v…`）
 * 做一次浅检出，只取源码，不安装也不构建——`typecheck` 与测试用的是安装好的那一份。
 * monorepo 内的同级目录已经就位，这种准备会被跳过。
 */

const root = path.resolve(import.meta.dirname, "..");
const LOCAL_SIBLING_PATTERN = /^(?:file|link):((?:\.\.\/){1,2})([a-z0-9][a-z0-9-]*)$/u;
const DEPENDENCY_SECTIONS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies"]);
const DEFAULT_BRANCH = "dev";

/** 精确的已发布版本（可带 `-YYYYMMDDNNN` 预发布段），相对引用与范围都不算。 */
const PINNED_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * 哪个同级仓库发布哪个包。
 *
 * 只有这张表里的包会被当作同级仓库处理：内置项目可能依赖任意 npm 包，而能从
 * `../<name>` 取到源码的只有这几个仓库。
 */
const SIBLING_PACKAGES = Object.freeze({
  "steamharness": "harness",
  "@steamharness/cli": "cli",
});

/** 一个版本可能挂在哪个 tag 下，按通道从新到旧。 */
const RELEASE_TAG_PREFIXES = Object.freeze(["alpha/v", "dev/v", "v"]);

export function readLocalSiblingNames(manifest) {
  const names = new Set();
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest?.[section];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const value of Object.values(dependencies)) {
      if (typeof value !== "string") continue;
      const match = LOCAL_SIBLING_PATTERN.exec(value.trim());
      if (match !== null) names.add(match[2]);
    }
  }
  return [...names].sort();
}

export function resolveSiblingWorkspaceRoot(projectRoot, manifest) {
  const prefixes = new Set();
  for (const section of DEPENDENCY_SECTIONS) {
    for (const value of Object.values(manifest?.[section] ?? {})) {
      if (typeof value !== "string") continue;
      const match = LOCAL_SIBLING_PATTERN.exec(value.trim());
      if (match !== null) prefixes.add(match[1]);
    }
  }
  if (prefixes.size > 1) throw new Error("Local sibling references must share one workspace root.");
  const relative = [...prefixes][0] ?? (path.basename(path.dirname(projectRoot)) === "build-in" ? "../.." : "..");
  return path.resolve(projectRoot, relative);
}

/**
 * 从 CI_REPOSITORY_URL 去掉 userinfo 再注入本次作业的 job token。runner 会复用构建
 * 目录，带上固定凭据比依赖 .git/config 里可能残留的旧 URL 更可靠。
 */
export function resolveRepositoryPrefix(env = process.env) {
  const repositoryUrl = String(env.CI_REPOSITORY_URL ?? "").trim();
  if (repositoryUrl === "") return undefined;
  const withoutGitSuffix = repositoryUrl.replace(/\/[^/]+\.git$/u, "");
  const scheme = withoutGitSuffix.slice(0, withoutGitSuffix.indexOf("://"));
  const remainder = withoutGitSuffix.slice(scheme.length + 3).replace(/^[^@/]*@/u, "");
  const token = String(env.CI_JOB_TOKEN ?? "").trim();
  return token === "" ? `${scheme}://${remainder}` : `${scheme}://gitlab-ci-token:${token}@${remainder}`;
}

/**
 * 声明为精确版本的兄弟包，按仓库名去重。
 *
 * 这些不是在本地引用的仓库，而是「CI 里要拿到它源码」的那几个：生成物按源码说话。
 */
export function readPinnedSiblings(manifest) {
  const pinned = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest?.[section];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const [packageName, sibling] of Object.entries(SIBLING_PACKAGES)) {
      const value = dependencies[packageName];
      if (typeof value !== "string") continue;
      const version = value.trim();
      if (!PINNED_VERSION_PATTERN.test(version)) continue;
      pinned.set(sibling, version);
    }
  }
  return [...pinned].map(([name, version]) => ({ name, version })).sort((left, right) => left.name.localeCompare(right.name));
}

/** 该版本实际存在的发布 tag，找不到时返回 undefined（例如手工发布的版本没有 tag）。 */
export function resolveReleaseTag(version, options = {}) {
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const run = options.run ?? runCommand;
  const repositoryPrefix = options.repositoryPrefix;
  const env = options.env ?? process.env;
  const sibling = options.sibling ?? "";
  for (const prefix of RELEASE_TAG_PREFIXES) {
    const tag = `${prefix}${version}`;
    const result = run("git", ["ls-remote", "--exit-code", "--tags", `${repositoryPrefix}/${sibling}.git`, `refs/tags/${tag}`], {
      cwd: options.cwd,
      env,
      capture: true,
      allowFailure: true,
    });
    // `--exit-code` is the answer: git exits 0 when the ref exists.
    if (result.status === 0) return tag;
  }
  log(`[local-siblings] no release tag found for ${sibling} ${version}; leaving the generated artifacts unverified.`);
  return undefined;
}

export function resolveSiblingBranch(env = process.env) {
  const explicit = String(env.STEAMHARNESS_SIBLING_BRANCH ?? "").trim();
  if (explicit !== "") return explicit;
  return String(env.CI_COMMIT_BRANCH ?? env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? DEFAULT_BRANCH).trim();
}

export function prepareLocalSiblings(options = {}) {
  const projectRoot = path.resolve(options.root ?? root);
  const env = options.env ?? process.env;
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const run = options.run ?? runCommand;
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const linked = readLocalSiblingNames(manifest);
  const pinned = readPinnedSiblings(manifest);
  if (linked.length === 0 && pinned.length === 0) {
    log("[local-siblings] no sibling references; nothing to prepare.");
    return { prepared: [] };
  }

  const workspaceRoot = resolveSiblingWorkspaceRoot(projectRoot, manifest);
  // Resolved only when something actually has to be cloned: a local run with
  // the aggregator's siblings already in place must not need a CI variable.
  const repositoryPrefix = () => {
    const prefix = options.repositoryPrefix ?? resolveRepositoryPrefix(env);
    if (prefix === undefined) {
      throw new Error("CI_REPOSITORY_URL is required to check out the sibling repositories.");
    }
    return prefix;
  };
  const branch = resolveSiblingBranch(env);
  // In CI the sibling path is *another project's build directory*: the runner
  // puts every project under one builds root, so `../harness` is whatever the
  // harness build left there — possibly a different commit, or one whose `dist`
  // was cleaned. Reusing it silently typechecks against the wrong sources, so
  // CI always starts from a fresh clone. Locally the monorepo already provides
  // the siblings and they are left alone.
  const refresh = options.refresh ?? isContinuousIntegration(env);
  const prepared = [];
  for (const name of linked.map((value) => ({ name: value, version: undefined })).concat(pinned)) {
    const target = path.join(workspaceRoot, name.name);
    if (!refresh && isPrepared(target)) {
      log(`[local-siblings] ${name.name} is already checked out.`);
      continue;
    }
    if (refresh) rmSync(target, { recursive: true, force: true });
    if (name.version !== undefined) {
      // 精确版本：只取源码给生成物用，装依赖与构建都按安装好的那一份来。
      const tag = resolveReleaseTag(name.version, {
        sibling: name.name,
        repositoryPrefix: repositoryPrefix(),
        cwd: workspaceRoot,
        env,
        log,
        // The same runner the rest of the checkout uses, so an injected one in
        // tests reaches the tag probe too.
        run: options.run,
      });
      if (tag === undefined) continue;
      log(`[local-siblings] checking out ${name.name} (${tag}) into ${target}`);
      run("git", ["clone", "--quiet", "--depth", "1", "--branch", tag, `${repositoryPrefix()}/${name.name}.git`, target], { cwd: workspaceRoot, env });
      prepared.push({ name: name.name, target, tag });
      continue;
    }
    log(`[local-siblings] checking out ${name.name} (${branch}) into ${target}`);
    run("git", ["clone", "--quiet", "--depth", "1", "--branch", branch, `${repositoryPrefix()}/${name.name}.git`, target], { cwd: workspaceRoot, env });
    const siblingManifest = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
    // 所有共享包都通过 workspace 解析，检出之后直接安装即可。
    const install = ["install", "--frozen-lockfile"];
    run("pnpm", install, { cwd: target, env });
    // 内置项目的 typecheck 走同级 harness 的 `dist/*.d.ts`（测试走 vitest 的
    // `development` 导出条件，不需要构建）。过期的 dist 比缺失的 dist 更糟：类型
    // 会静默对不上源码，所以这里一律重建，而不是只在 dist 不存在时构建。
    if (typeof siblingManifest?.scripts?.build === "string") {
      run("pnpm", ["build"], { cwd: target, env });
    }
    prepared.push({ name: name.name, target, install });
  }
  return { prepared };
}

export function isContinuousIntegration(env = process.env) {
  return String(env.CI_JOB_TOKEN ?? "").trim() !== "" || String(env.CI_REPOSITORY_URL ?? "").trim() !== "";
}

function isPrepared(target) {
  return existsSync(path.join(target, "package.json"));
}

function runCommand(command, args, options) {
  const invocation = process.platform === "win32" && command === "pnpm"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", ...args] }
    : { command, args };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.capture === true ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? 1} in ${options.cwd}.`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    prepareLocalSiblings();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
