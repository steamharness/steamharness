#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { closeSync, constants, openSync, realpathSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export async function activateDocsService(options = {}) {
  const releaseRoot = resolveSafeDirectory(
    options.releaseRoot ?? process.env.STEAMHARNESS_DOCS_RELEASE_ROOT,
    "STEAMHARNESS_DOCS_RELEASE_ROOT",
  );
  const runtimeRoot = resolveSafeDirectory(
    options.runtimeRoot ?? process.env.STEAMHARNESS_DOCS_RUNTIME_ROOT,
    "STEAMHARNESS_DOCS_RUNTIME_ROOT",
  );
  const commitSha = String(
    options.commitSha ?? process.env.STEAMHARNESS_DOCS_DEPLOY_COMMIT ?? "",
  ).trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commitSha)) {
    throw new Error("Docs activation requires an exact 40-character commit SHA.");
  }

  const rawNodeBin = String(options.nodeBin ?? process.execPath).trim();
  if (!rawNodeBin || !path.isAbsolute(rawNodeBin)) {
    throw new Error("Docs activation requires an absolute Node.js executable path.");
  }
  const nodeBin = path.resolve(rawNodeBin);
  const serverScript = path.join(releaseRoot, ".steamharness", "serve-docs.mjs");
  await access(nodeBin, constants.X_OK);
  await Promise.all([
    assertFile(path.join(releaseRoot, "index.html"), "Docusaurus index"),
    assertFile(path.join(releaseRoot, "en", "index.html"), "Docusaurus English index"),
    assertFile(serverScript, "Docusaurus static server"),
    assertDeployment(path.join(releaseRoot, "deployment.json"), commitSha),
  ]);

  const host = String(options.host ?? process.env.STEAMHARNESS_DOCS_HOST ?? "0.0.0.0").trim();
  if (!host) throw new Error("STEAMHARNESS_DOCS_HOST must not be empty.");
  const port = normalizePort(options.port ?? process.env.STEAMHARNESS_DOCS_PORT ?? 7132, "STEAMHARNESS_DOCS_PORT");
  const preflightPort = normalizePort(
    options.preflightPort ?? process.env.STEAMHARNESS_DOCS_PREFLIGHT_PORT ?? 17132,
    "STEAMHARNESS_DOCS_PREFLIGHT_PORT",
  );
  if (port === preflightPort) throw new Error("Docs production and preflight ports must differ.");
  const startupTimeoutMs = normalizeTimeout(
    options.startupTimeoutMs ?? process.env.STEAMHARNESS_DOCS_STARTUP_TIMEOUT_MS ?? 30_000,
  );
  const command = options.command ?? nodeBin;
  const prefixArgs = options.prefixArgs ?? [serverScript];
  if (!Array.isArray(prefixArgs) || prefixArgs.some((value) => typeof value !== "string")) {
    throw new Error("Docs activation command prefix arguments must be strings.");
  }

  const logsRoot = path.join(runtimeRoot, "logs");
  const pidFile = path.join(runtimeRoot, "docusaurus-static.pid");
  const preflightPidFile = path.join(runtimeRoot, "docusaurus-preflight.pid");
  await Promise.all([mkdir(runtimeRoot, { recursive: true }), mkdir(logsRoot, { recursive: true })]);
  await stopDocsProcess(preflightPidFile, options);

  const preflightLog = path.join(logsRoot, `${commitSha}-preflight.log`);
  const preflightPid = await startStaticServer({
    command,
    prefixArgs,
    releaseRoot,
    host: "127.0.0.1",
    port: preflightPort,
    pidFile: preflightPidFile,
    logFile: preflightLog,
  });
  try {
    await waitForHealthyDocs({
      pid: preflightPid,
      port: preflightPort,
      commitSha,
      timeoutMs: startupTimeoutMs,
      fetchImpl: options.fetchImpl,
      label: "Docusaurus preflight",
    });
  } catch (error) {
    throw await withServiceLog(error, preflightLog);
  } finally {
    await stopDocsProcess(preflightPidFile, options);
  }

  await stopDocsProcess(pidFile, options);
  for (const legacyPid of ["mint-preflight.pid", "mint-dev.pid"]) {
    await stopDocsProcess(path.join(runtimeRoot, legacyPid), options);
  }

  const productionLog = path.join(logsRoot, `${commitSha}-production.log`);
  const productionPid = await startStaticServer({
    command,
    prefixArgs,
    releaseRoot,
    host,
    port,
    pidFile,
    logFile: productionLog,
  });
  try {
    await waitForHealthyDocs({
      pid: productionPid,
      port,
      commitSha,
      timeoutMs: startupTimeoutMs,
      fetchImpl: options.fetchImpl,
      label: "Docusaurus production",
    });
  } catch (error) {
    await stopDocsProcess(pidFile, options);
    throw await withServiceLog(error, productionLog);
  }

  const deployment = {
    schemaVersion: 1,
    framework: "docusaurus",
    commitSha,
    branch: "main",
    tag: null,
    sourceDir: releaseRoot,
    releaseRoot,
    pid: productionPid,
    host,
    port,
    activatedAt: options.activatedAt ?? new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(runtimeRoot, "deployment.json"), deployment);
  return deployment;
}

export async function stopDocsProcess(pidFile, options = {}) {
  const pid = await readPid(pidFile);
  if (pid === undefined) {
    await rm(pidFile, { force: true });
    return;
  }
  if (process.platform === "win32") {
    await (options.execFile ?? execFileAsync)("taskkill", ["/PID", String(pid), "/T", "/F"])
      .catch(() => undefined);
  } else {
    const descendants = await readDescendantPids(pid, options.execFile ?? execFileAsync);
    for (const processId of [pid, ...descendants.reverse()]) safeKill(processId, "SIGTERM");
    await waitForProcessesToExit([pid, ...descendants], 10_000);
    for (const processId of [pid, ...descendants]) safeKill(processId, "SIGKILL");
    await waitForProcessesToExit([pid, ...descendants], 5_000);
  }
  await rm(pidFile, { force: true });
}

async function startStaticServer(options) {
  const args = [
    ...options.prefixArgs,
    "--root",
    options.releaseRoot,
    "--host",
    options.host,
    "--port",
    String(options.port),
  ];
  const logFd = openSync(options.logFile, "a");
  let child;
  try {
    child = spawn(options.command, args, {
      cwd: options.releaseRoot,
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  await writeFile(options.pidFile, `${child.pid}\n`, "utf8");
  return child.pid;
}

async function waitForHealthyDocs(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + options.timeoutMs;
  const url = `http://127.0.0.1:${options.port}/`;
  while (Date.now() < deadline) {
    if (!isProcessAlive(options.pid)) {
      throw new Error(`${options.label} exited before becoming healthy.`);
    }
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(2_000, options.timeoutMs)),
      });
      await response.body?.cancel();
      if (
        response.ok
        && response.headers.get("x-steamharness-docs-framework") === "docusaurus"
        && response.headers.get("x-steamharness-docs-commit") === options.commitSha
      ) return;
    } catch {
      // The static server may still be binding its port.
    }
    await delay(250);
  }
  throw new Error(`${options.label} did not become healthy within ${options.timeoutMs}ms.`);
}

async function assertDeployment(filePath, commitSha) {
  const deployment = JSON.parse(await readFile(filePath, "utf8"));
  if (deployment.schemaVersion !== 1 || deployment.framework !== "docusaurus") {
    throw new Error("Docs release does not contain Docusaurus deployment metadata.");
  }
  if (deployment.commitSha !== commitSha) {
    throw new Error(`Docs release commit ${deployment.commitSha} does not match ${commitSha}.`);
  }
}

async function readDescendantPids(parentPid, exec) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid="]);
  const children = new Map();
  for (const line of stdout.split("\n")) {
    const [pidValue, parentValue] = line.trim().split(/\s+/u).map(Number);
    if (!Number.isInteger(pidValue) || !Number.isInteger(parentValue)) continue;
    const entries = children.get(parentValue) ?? [];
    entries.push(pidValue);
    children.set(parentValue, entries);
  }
  const descendants = [];
  const queue = [...(children.get(parentPid) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    descendants.push(current);
    queue.push(...(children.get(current) ?? []));
  }
  return descendants;
}

async function waitForProcessesToExit(processIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processIds.every((pid) => !isProcessAlive(pid))) return;
    await delay(100);
  }
}

function safeKill(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // An already exited process needs no further cleanup.
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidFile) {
  const raw = await readOptionalText(pidFile);
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function readOptionalText(filePath) {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function withServiceLog(error, logFile) {
  const log = await readOptionalText(logFile);
  if (!log) return error;
  const detail = log.length > 4_000 ? log.slice(-4_000) : log;
  return new Error(`${error instanceof Error ? error.message : String(error)}\nService log (${logFile}):\n${detail}`, {
    cause: error,
  });
}

function resolveSafeDirectory(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error(`${label} must be an absolute path.`);
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new Error(`Refusing unsafe ${label}: ${resolved}`);
  }
  return resolved;
}

function normalizePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be a valid TCP port.`);
  }
  return port;
}

function normalizeTimeout(value) {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error("STEAMHARNESS_DOCS_STARTUP_TIMEOUT_MS must be between 1000 and 120000.");
  }
  return timeout;
}

async function assertFile(filePath, label) {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${label} does not exist: ${filePath}`);
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const result = await activateDocsService();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
