import { createRequire } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { prepareDevelopmentSources } from "./development-sources.mjs";
import { resolveRepositoryMode } from "./repository-mode.mjs";
import { runDevelopmentServer } from "./development-memory.mjs";

const root = path.resolve(import.meta.dirname, "..");

export async function createServerRunPlan({
  root: repositoryRoot = root,
  env = process.env,
  branch,
  hotReload = true,
  prepareDevelopment = prepareDevelopmentSources,
} = {}) {
  const mode = resolveRepositoryMode({ root: repositoryRoot, env, branch });
  if (mode === "main") {
    const mainEnv = withoutLocalSourceEnvironment(env);
    return {
      mode,
      hotReload: false,
      build: ["pnpm", ["build:all"]],
      command: process.execPath,
      args: [path.join(repositoryRoot, "dist", "index.js")],
      env: { ...mainEnv, NODE_ENV: "production", STEAMHARNESS_REPOSITORY_MODE: "main" },
    };
  }

  const requireFromServer = createRequire(path.join(repositoryRoot, "package.json"));
  let tsxCliPath;
  try {
    tsxCliPath = requireFromServer.resolve("tsx/cli");
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND") {
      throw new Error("Server dependencies are missing (tsx/cli). Run pnpm install at the monorepo root, then retry.", { cause: error });
    }
    throw error;
  }
  const { tsconfigPath, harnessRoot, sharedRoot } = await prepareDevelopment({ root: repositoryRoot });
  return {
    mode,
    hotReload,
    command: process.execPath,
    args: [
      tsxCliPath,
      ...(hotReload ? ["watch", "--clear-screen=false"] : []),
      "--tsconfig",
      tsconfigPath,
      // tsx's built-in ignore of dot-directories only covers paths under the
      // Server working directory, so git metadata writes in the sibling
      // checkouts (auto-fetch, GitKraken touching .git/gk) would otherwise
      // restart the dev server.
      ...(hotReload
        ? [
            "--include", path.join(harnessRoot, "src"),
            "--include", sharedRoot,
            "--exclude", path.join(harnessRoot, ".git"),
            "--exclude", path.join(sharedRoot, ".git"),
          ]
        : []),
      path.join(repositoryRoot, "src", "index.ts"),
    ],
    env: {
      ...env,
      NODE_ENV: "development",
      NODE_OPTIONS: withDevelopmentCondition(env.NODE_OPTIONS),
      STEAMHARNESS_SERVER_DEV: "1",
      STEAMHARNESS_SERVER_HMR: hotReload ? "1" : "0",
      TSX_TSCONFIG_PATH: tsconfigPath,
      STEAMHARNESS_LOCAL_HARNESS_ROOT: harnessRoot,
      STEAMHARNESS_LOCAL_SHARED_ROOT: sharedRoot,
      STEAMHARNESS_LOCAL_SOURCE_MODE: "1",
    },
  };
}

function withoutLocalSourceEnvironment(env) {
  const result = { ...env };
  for (const key of [
    "TSX_TSCONFIG_PATH",
    "STEAMHARNESS_LOCAL_HARNESS_ROOT",
    "STEAMHARNESS_LOCAL_SHARED_ROOT",
    "STEAMHARNESS_LOCAL_SOURCE_MODE",
    "STEAMHARNESS_SERVER_DEV",
    "STEAMHARNESS_SERVER_HMR",
  ]) delete result[key];
  const nodeOptions = withoutDevelopmentCondition(result.NODE_OPTIONS);
  if (nodeOptions === undefined) delete result.NODE_OPTIONS;
  else result.NODE_OPTIONS = nodeOptions;
  return result;
}

function withoutDevelopmentCondition(value) {
  const pattern = /(^|\s)(?:--conditions=development|--conditions\s+development|-C=development|-C\s+development)(?:\s+|$)/g;
  let filtered = String(value ?? "");
  let previous;
  do {
    previous = filtered;
    filtered = filtered.replace(pattern, "$1");
  } while (filtered !== previous);
  filtered = filtered.trim();
  return filtered || undefined;
}

function withDevelopmentCondition(value) {
  const current = String(value ?? "").trim();
  if (/(?:^|\s)(?:--conditions|-C)(?:=|\s+)development(?:\s|$)/.test(current)) return current;
  return [current, "--conditions=development"].filter(Boolean).join(" ");
}

async function main() {
  const plan = await createServerRunPlan({ hotReload: !process.argv.includes("--no-hmr") });
  const runtime = plan.mode === "main"
    ? "dist + static web"
    : plan.hotReload ? "source watch + Vite HMR" : "source + manual web reload";
  process.stdout.write(`[repository:${plan.mode}] Server ${runtime} runtime\n`);
  if (plan.build !== undefined) await run(plan.build[0], plan.build[1], { cwd: root, env: plan.env });
  process.exitCode = plan.mode === "dev"
    ? await runDevelopmentServer({ root, command: plan.command, args: plan.args, env: plan.env })
    : await run(plan.command, plan.args, { cwd: root, env: plan.env });
}

function run(command, args, options) {
  const invocation = createInvocation(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function createInvocation(command, args) {
  if (process.platform === "win32" && command === "pnpm") {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", ...args] };
  }
  return { command, args };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
