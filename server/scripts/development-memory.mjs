import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "dotenv";

/** Match src/env.ts precedence before either child is created. Never edit .env. */
export function loadDevelopmentEnvironment({ root, env = process.env }) {
  const result = { ...env };
  if (result.STEAMHARNESS_SKIP_ENV_FILES === "1") return result;
  const load = (directory) => {
    const file = path.join(directory, ".env");
    if (!existsSync(file)) return;
    for (const [key, value] of Object.entries(parse(readFileSync(file)))) {
      if (result[key] === undefined) result[key] = value;
    }
  };
  const initialRoot = path.resolve(root, result.STEAMHARNESS_REPO_ROOT || ".");
  load(initialRoot);
  const resolvedRoot = path.resolve(root, result.STEAMHARNESS_REPO_ROOT || ".");
  if (resolvedRoot !== initialRoot) load(resolvedRoot);
  return result;
}

export function shouldStartDevelopmentMemory(env) {
  return env.STEAMHARNESS_SERVER_MEMORY_DISABLED !== "1"
    && env.STEAMHARNESS_SERVER_MEMORY_AUTOSTART !== "0"
    && !env.STEAMHARNESS_SERVER_MEMORY_URL?.trim();
}

function managedChild(command, args, options) {
  // A separate process group lets the supervisor stop tsx watch and its runtime.
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
  const closed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: 1, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let stopping;
  const kill = (signal) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
      } else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  return {
    child,
    closed,
    stop() {
      return stopping ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        kill("SIGTERM");
        const timer = setTimeout(() => kill("SIGKILL"), 5000);
        try { await closed; } finally { clearTimeout(timer); }
      })();
    },
  };
}

export async function startDevelopmentMemory({
  root,
  memoryRoot = path.resolve(import.meta.dirname, "../../memory-service"),
  env = process.env,
  signal,
  readyTimeout = 15000,
  log = console.log,
}) {
  if (!shouldStartDevelopmentMemory(env) || signal?.aborted) return { env, stop: async () => {} };
  const token = env.STEAMHARNESS_SERVER_MEMORY_TOKEN?.trim()
    || env.STEAMHARNESS_MEMORY_SERVICE_TOKEN?.trim() || randomBytes(32).toString("hex");
  if (token.length < 32) throw new Error("Local memory service requires a token of at least 32 characters.");
  const requireMemory = createRequire(path.join(memoryRoot, "package.json"));
  let loader;
  try { loader = requireMemory.resolve("tsx"); } catch {
    throw new Error("Memory service dependencies are missing. Run pnpm install at the monorepo root.");
  }
  const serverRoot = path.resolve(root, env.STEAMHARNESS_REPO_ROOT || ".");
  const explicitDataRoot = env.STEAMHARNESS_SERVER_DATA_DIR?.trim() || env.STEAMHARNESS_SERVER_DEPLOY_DIR?.trim();
  const dataRoot = explicitDataRoot ? path.resolve(root, explicitDataRoot) : path.join(serverRoot, ".data");
  const serviceEnv = {
    ...env,
    STEAMHARNESS_MEMORY_HOST: "127.0.0.1",
    STEAMHARNESS_MEMORY_PORT: env.STEAMHARNESS_MEMORY_PORT?.trim() || "0",
    STEAMHARNESS_MEMORY_SERVICE_TOKEN: token,
    STEAMHARNESS_MEMORY_DATA_DIR: env.STEAMHARNESS_MEMORY_DATA_DIR?.trim()
      ? path.resolve(root, env.STEAMHARNESS_MEMORY_DATA_DIR.trim()) : path.join(dataRoot, "memory"),
  };
  delete serviceEnv.TSX_TSCONFIG_PATH;
  const service = managedChild(process.execPath, ["--import", pathToFileURL(loader).href, path.join(memoryRoot, "src/index.ts")], {
    cwd: memoryRoot,
    env: serviceEnv,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const abort = () => { void service.stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  const stop = async () => {
    signal?.removeEventListener("abort", abort);
    await service.stop();
  };
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Local memory service readiness timed out.")), readyTimeout);
      const onMessage = (message) => {
        if (message?.type === "steamharness:memory-ready" && Number.isInteger(message.port)
          && message.port > 0 && message.port <= 65535) finish(undefined, `http://127.0.0.1:${message.port}`);
      };
      const onAbort = () => finish(new Error("Local memory service startup was stopped."));
      const finish = (error, value) => {
        clearTimeout(timeout);
        service.child.off("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(value);
      };
      service.child.on("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
      void service.closed.then(() => finish(new Error("Local memory service exited before it was ready.")));
      if (signal?.aborted) onAbort();
    });
    const response = await fetch(`${url}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok || (await response.json()).fts !== true) throw new Error("Local memory service health check failed.");
    log("[memory] Local service ready (loopback, persistent SQLite, no embedding required).");
    return {
      env: { ...env, STEAMHARNESS_SERVER_MEMORY_URL: url, STEAMHARNESS_SERVER_MEMORY_TOKEN: token },
      stop,
      closed: service.closed,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** One supervisor for public and internal development entry points. */
export async function runDevelopmentServer({ root, command, args, env = process.env, memoryRoot, log = console.log, warn = console.warn }) {
  const controller = new AbortController();
  let interrupted;
  let runtime;
  let memory;
  const interrupt = (signal) => {
    interrupted ??= signal;
    controller.abort();
    void runtime?.stop();
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const loadedEnv = loadDevelopmentEnvironment({ root, env });
    try {
      memory = await startDevelopmentMemory({ root, env: loadedEnv, memoryRoot, signal: controller.signal, log });
    } catch (error) {
      if (!controller.signal.aborted) warn(`[memory] ${error.message} Server will continue without local memory.`);
    }
    if (controller.signal.aborted) return interrupted === "SIGINT" ? 130 : 143;
    let stopping = false;
    void memory?.closed?.then(() => {
      if (!stopping && !controller.signal.aborted) warn("[memory] Local service stopped unexpectedly; Server remains available. Restart the dev command to restore memory.");
    });
    runtime = managedChild(command, args, { cwd: root, env: memory?.env ?? loadedEnv, stdio: "inherit" });
    const result = await runtime.closed;
    stopping = true;
    if (result.error) warn("[server] The development process could not be started.");
    return interrupted ? (interrupted === "SIGINT" ? 130 : 143)
      : result.code ?? (result.signal === "SIGINT" ? 130 : 1);
  } finally {
    await runtime?.stop();
    await memory?.stop();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
