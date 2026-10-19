import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertReleaseStorageRootWritable,
  loadProductionEnv,
  resolveServerDataRoot,
} from "./release-storage.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const entry = path.join(serverRoot, "dist", "index.js");

loadProductionEnv();

const dataRoot = resolveServerDataRoot({ requiredForRelease: true, serverRoot });
const logsRoot = path.join(dataRoot, "logs");
const pidFile = path.join(dataRoot, "server.pid");
const logFile = path.join(logsRoot, "server.log");

const command = process.argv[2] ?? "start";

switch (command) {
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "status":
    await status();
    break;
  default:
    console.error(`Unknown deploy command: ${command}`);
    console.error("Usage: node scripts/deploy.mjs <start|stop|status>");
    process.exit(1);
}

async function start() {
  await assertEntryExists();
  await assertReleaseStorageRootWritable();
  await mkdir(logsRoot, { recursive: true });
  await stop({ quiet: true });

  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [entry], {
    cwd: serverRoot,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      STEAMHARNESS_SERVER_DATA_DIR: process.env.STEAMHARNESS_SERVER_DATA_DIR ?? dataRoot,
    },
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  closeSync(logFd);
  await writeFile(pidFile, `${child.pid}\n`, "utf8");

  const ready = await waitForHealth(child.pid, 15000);
  if (!ready) {
    if (!isProcessAlive(child.pid)) {
      await rm(pidFile, { force: true });
      console.error("SteamHarness server exited during startup");
    } else {
      process.kill(child.pid, "SIGTERM");
      await waitForExit(child.pid, 5000);
      if (isProcessAlive(child.pid)) {
        process.kill(child.pid, "SIGKILL");
        await waitForExit(child.pid, 5000);
      }
      await rm(pidFile, { force: true });
      console.error("SteamHarness server did not become healthy before timeout");
    }
    console.error(`log: ${logFile}`);
    process.exit(1);
  }

  console.log(`SteamHarness server started with pid ${child.pid}`);
  console.log(`url: http://localhost:${readPort()}`);
  console.log(`log: ${logFile}`);
}

async function stop(options = {}) {
  const pid = await readPid();

  if (pid === undefined) {
    if (!options.quiet) {
      console.log("SteamHarness server is not running");
    }
    return;
  }

  if (!isProcessAlive(pid)) {
    await rm(pidFile, { force: true });
    if (!options.quiet) {
      console.log(`removed stale pid file for pid ${pid}`);
    }
    return;
  }

  process.kill(pid, "SIGTERM");
  const stopped = await waitForExit(pid, 10000);

  if (!stopped && isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForExit(pid, 5000);
  }

  await rm(pidFile, { force: true });

  if (!options.quiet) {
    console.log(`SteamHarness server stopped pid ${pid}`);
  }
}

async function status() {
  const pid = await readPid();

  if (pid !== undefined && isProcessAlive(pid)) {
    console.log(`SteamHarness server is running with pid ${pid}`);
    console.log(`log: ${logFile}`);
    return;
  }

  if (pid !== undefined) {
    await rm(pidFile, { force: true });
    console.log(`SteamHarness server is not running; removed stale pid file for pid ${pid}`);
    return;
  }

  console.log("SteamHarness server is not running");
}

async function assertEntryExists() {
  try {
    const info = await stat(entry);
    if (info.isFile()) return;
  } catch {
    // handled below
  }

  console.error(`Server entry not found: ${entry}`);
  console.error("Run `pnpm build` before starting the deployment.");
  process.exit(1);
}

async function readPid() {
  try {
    const raw = await readFile(pidFile, "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
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

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(250);
  }

  return !isProcessAlive(pid);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${readPort()}/health`;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return false;
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // Server may still be booting.
    }

    await delay(500);
  }

  return false;
}

function readPort() {
  // Deploy/start scripts target the release port band even though
  // local dev keeps using the existing 712x defaults.
  const raw = process.env.STEAMHARNESS_SERVER_PORT || process.env.PORT || "7130";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7130;
}
