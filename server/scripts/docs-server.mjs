import express from "express";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDirectory,
  assertReleaseStorageRootWritable,
  loadProductionEnv,
  readHostEnv,
  readPositiveIntegerEnv,
  resolveDocsRoot,
  resolveReleasePaths,
  resolveServerDataRoot,
} from "./release-storage.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const command = process.argv[2] ?? "start";

loadProductionEnv();

const { repoRoot } = resolveReleasePaths();
const runtimeDataRoot = resolveServerDataRoot({ requiredForRelease: true, serverRoot });
const serviceDataRoot = path.join(runtimeDataRoot, "docs-service");
const logsRoot = path.join(serviceDataRoot, "logs");
const pidFile = path.join(serviceDataRoot, "docs-server.pid");
const logFile = path.join(logsRoot, "docs-server.log");
const host = readHostEnv("STEAMHARNESS_DOCS_HOST", "127.0.0.1");
const port = readPositiveIntegerEnv("STEAMHARNESS_DOCS_PORT", 7132);

switch (command) {
  case "serve":
    await serve();
    break;
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
    console.error("Usage: node scripts/docs-server.mjs <serve|start|stop|status>");
    process.exit(1);
}

async function serve() {
  const docsRoot = await prepareDocsRoot();
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({
      errCode: 0,
      errMessage: "",
      data: {
        status: "ok",
        root: docsRoot,
      },
    });
  });

  app.use(express.static(docsRoot, {
    fallthrough: false,
    extensions: ["html"],
    index: "index.html",
  }));

  app.use((error, _req, res, _next) => {
    if (error && typeof error === "object" && "status" in error && error.status === 404) {
      res.status(404).json({
        errCode: 404,
        errMessage: "Not Found",
      });
      return;
    }

    res.status(500).json({
      errCode: 500,
      errMessage: "Internal Server Error",
    });
  });

  await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`[steamharness-docs] serving ${docsRoot} on http://${host}:${port}`);
      resolve(undefined);
    });
    server.on("error", reject);
  });
}

async function start() {
  await prepareDocsRoot();
  await mkdir(logsRoot, { recursive: true });
  await stop({ quiet: true });

  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join(serverRoot, "scripts", "docs-server.mjs"), "serve"], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      STEAMHARNESS_REPO_ROOT: process.env.STEAMHARNESS_REPO_ROOT ?? repoRoot,
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
      console.error("docs server exited during startup");
    } else {
      process.kill(child.pid, "SIGTERM");
      await waitForExit(child.pid, 5000);
      if (isProcessAlive(child.pid)) {
        process.kill(child.pid, "SIGKILL");
        await waitForExit(child.pid, 5000);
      }
      await rm(pidFile, { force: true });
      console.error("docs server did not become healthy before timeout");
    }
    console.error(`log: ${logFile}`);
    process.exit(1);
  }

  console.log(`SteamHarness docs server started with pid ${child.pid}`);
  console.log(`url: http://${host}:${port}`);
  console.log(`root: ${resolveDocsRoot()}`);
  console.log(`log: ${logFile}`);
}

async function stop(options = {}) {
  const pid = await readPid();

  if (pid === undefined) {
    if (!options.quiet) {
      console.log("SteamHarness docs server is not running");
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
    console.log(`SteamHarness docs server stopped pid ${pid}`);
  }
}

async function status() {
  const pid = await readPid();

  if (pid !== undefined && isProcessAlive(pid)) {
    console.log(`SteamHarness docs server is running with pid ${pid}`);
    console.log(`url: http://${host}:${port}`);
    console.log(`root: ${resolveDocsRoot()}`);
    console.log(`log: ${logFile}`);
    return;
  }

  if (pid !== undefined) {
    await rm(pidFile, { force: true });
    console.log(`SteamHarness docs server is not running; removed stale pid file for pid ${pid}`);
    return;
  }

  console.log("SteamHarness docs server is not running");
}

async function prepareDocsRoot() {
  // release docs must resolve from the published stable directory on
  // the mounted external-disk root so public release docs reflect deployed tags.
  await assertReleaseStorageRootWritable();
  const docsRoot = resolveDocsRoot();
  await assertDirectory(docsRoot, {
    label: "STEAMHARNESS_DOCS_ROOT",
  });
  return docsRoot;
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

async function waitForHealth(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${host}:${port}/health`;

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
