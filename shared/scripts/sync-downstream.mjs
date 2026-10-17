import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET_NAMES = Object.freeze(["harness", "cli", "server"]);

export async function exportSharedSource(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const sourceRoot = path.resolve(options.sourceRoot ?? path.join(root, "dist", "source"));
  await assertSharedSource(sourceRoot);

  const targets = options.outputRoot
    ? DEFAULT_TARGET_NAMES.map((name) => ({ name, root: path.resolve(options.outputRoot, name), validate: false }))
    : resolveLocalTargets(root, options.targets);
  if (targets.length === 0) {
    throw new Error("No local downstream repositories were found. Use --output-root for a CI export bundle.");
  }

  const exported = [];
  for (const target of targets) {
    if (target.validate !== false) await assertConsumerRoot(target.root);
    const destination = path.join(target.root, "vendor", "shared");
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(sourceRoot, destination, { recursive: true });
    exported.push({ name: target.name, destination });
  }
  return exported;
}

export async function syncRemoteTargets(options = {}) {
  if (options.enabled !== true) {
    throw new Error("Remote Shared synchronization requires STEAMHARNESS_SHARED_REMOTE_SYNC=true or --remote.");
  }
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const sourceRoot = path.resolve(options.sourceRoot ?? path.join(root, "dist", "source"));
  await assertSharedSource(sourceRoot);
  const token = String(options.token ?? process.env.STEAMHARNESS_SHARED_SYNC_TOKEN ?? "").trim();
  const targets = parseTargets(options.targets ?? process.env.STEAMHARNESS_SHARED_SYNC_TARGETS);
  if (!token) throw new Error("STEAMHARNESS_SHARED_SYNC_TOKEN is required for remote synchronization.");
  if (targets.length === 0) throw new Error("STEAMHARNESS_SHARED_SYNC_TARGETS must contain at least one GitLab project path.");

  const serverUrl = resolveGitLabServerUrl(options);
  const gitEnv = createGitAuthenticationEnv(token, options.env ?? process.env);
  const branch = String(
    options.branch
      ?? process.env.STEAMHARNESS_SHARED_SYNC_BRANCH
      ?? (process.env.CI_COMMIT_BRANCH === "alpha" ? "alpha" : "dev"),
  ).trim();
  if (!/^[a-z0-9][a-z0-9._/-]*$/iu.test(branch)) throw new Error(`Invalid synchronization branch: ${branch}`);
  const run = options.runCommand ?? runCommand;
  const results = [];
  for (const target of targets) {
    results.push(await syncRemoteTarget({
      root,
      sourceRoot,
      target,
      serverUrl,
      branch,
      gitEnv,
      run,
      commitSha: options.commitSha,
      attempts: options.attempts ?? 5,
      skipCi: options.skipCi === true,
    }));
  }
  return results;
}

async function syncRemoteTarget(options) {
  const projectPath = options.target.split("/").map(encodeURIComponent).join("/");
  const remote = `${options.serverUrl}/${projectPath}.git`;
  let lastError;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const checkout = await mkdtemp(path.join(os.tmpdir(), "workflow-shared-sync-"));
    try {
      await options.run("git", ["clone", "--branch", options.branch, "--depth", "1", remote, checkout], {
        cwd: options.root,
        env: options.gitEnv,
      });
      const destination = path.join(checkout, "vendor", "shared");
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(options.sourceRoot, destination, { recursive: true });
      await options.run("git", ["add", "vendor/shared"], { cwd: checkout });
      const status = await options.run("git", ["status", "--porcelain"], { cwd: checkout, capture: true });
      if (status.trim() === "") return { target: options.target, branch: options.branch, changed: false };
      await options.run("git", ["config", "user.name", "Workflow Shared Sync"], { cwd: checkout });
      await options.run("git", ["config", "user.email", "workflow-shared-sync@localhost"], { cwd: checkout });
      const sourceSha = String(options.commitSha ?? process.env.CI_COMMIT_SHA ?? "local").slice(0, 12);
      await options.run("git", ["commit", "-m", `chore: sync shared source ${sourceSha}`], { cwd: checkout });
      await options.run("git", ["push", ...(options.skipCi ? ["-o", "ci.skip"] : []), "origin", `HEAD:${options.branch}`], {
        cwd: checkout,
        env: options.gitEnv,
        capture: true,
      });
      return { target: options.target, branch: options.branch, changed: true };
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || !/rejected|fetch first|non-fast-forward|failed to push/u.test(String(error))) throw error;
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }
  throw lastError;
}

export function resolveGitLabServerUrl(options = {}) {
  const configured = String(options.serverUrl ?? process.env.CI_SERVER_URL ?? "").trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("CI_SERVER_URL must use HTTP or HTTPS.");
    if (url.username || url.password) throw new Error("CI_SERVER_URL must not contain credentials.");
    return url.href.replace(/\/$/u, "");
  }

  const protocol = String(options.protocol ?? process.env.CI_SERVER_PROTOCOL ?? "https").trim();
  const host = String(options.host ?? process.env.CI_SERVER_HOST ?? "").trim();
  const port = String(options.port ?? process.env.CI_SERVER_PORT ?? "").trim();
  if (!host) throw new Error("CI_SERVER_URL or CI_SERVER_HOST is required for remote synchronization.");
  return `${protocol}://${host}${port ? `:${port}` : ""}`;
}

export function createGitAuthenticationEnv(token, baseEnv = process.env) {
  const authorization = Buffer.from(`oauth2:${token}`, "utf8").toString("base64");
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
  };
}

export function parseTargets(value) {
  return [...new Set(String(value ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean))];
}

function resolveLocalTargets(root, value) {
  const configured = parseLocalTargets(value ?? process.env.STEAMHARNESS_SHARED_LOCAL_TARGETS);
  const rawTargets = configured.length > 0
    ? configured.map((entry) => path.isAbsolute(entry) ? entry : path.resolve(root, entry))
    : DEFAULT_TARGET_NAMES.map((name) => path.resolve(root, "..", name));
  return rawTargets.map((targetRoot) => ({
    name: path.basename(targetRoot),
    root: targetRoot,
    validate: true,
  }));
}

function parseLocalTargets(value) {
  return [...new Set(String(value ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

async function assertSharedSource(directory) {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, "i18n", "package.json"), "utf8"));
    if (manifest.name === "@steamharness/i18n") return;
  } catch {
    // Fall through to the stable error below.
  }
  throw new Error(`Built Shared source is missing or invalid: ${directory}`);
}

async function assertConsumerRoot(directory) {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    if (typeof manifest.name === "string" && manifest.name !== "") return;
  } catch {
    // Fall through to the stable error below.
  }
  throw new Error(`Downstream repository is missing package.json: ${directory}`);
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let output = "";
    if (options.capture) child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(output)
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}.`)));
  });
}

function parseArgs(argv) {
  const options = { remote: false, skipLocal: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--remote") {
      options.remote = true;
      continue;
    }
    if (token === "--skip-local") {
      options.skipLocal = true;
      continue;
    }
    if (token === "--skip-ci") {
      options.skipCi = true;
      continue;
    }
    if (token === "--output-root" || token === "--targets" || token === "--branch") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${token}.`);
      options[token === "--output-root" ? "outputRoot" : token.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, "..");
  const args = parseArgs(process.argv.slice(2));
  const result = {};
  if (!args.skipLocal) {
    result.local = await exportSharedSource({
      root,
      outputRoot: args.outputRoot ? path.resolve(root, args.outputRoot) : undefined,
      targets: args.targets,
    });
  }
  const remoteEnabled = args.remote || process.env.STEAMHARNESS_SHARED_REMOTE_SYNC === "true";
  if (remoteEnabled) {
    result.remote = await syncRemoteTargets({ root, enabled: true, branch: args.branch, skipCi: args.skipCi });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
