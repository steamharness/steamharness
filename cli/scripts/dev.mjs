import { createRequire } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { prepareDevelopmentSources } from "./development-sources.mjs";
import { prepareSharedPackages } from "./prepare-shared.mjs";
import { resolveRepositoryMode } from "./repository-mode.mjs";

const root = path.resolve(import.meta.dirname, "..");

export async function createCliRunPlan({
  root: repositoryRoot = root,
  env = process.env,
  branch,
  argv = [],
  prepareDevelopment = prepareDevelopmentSources,
} = {}) {
  const mode = resolveRepositoryMode({ root: repositoryRoot, env, branch });
  if (mode === "main") {
    const mainEnv = withoutLocalSourceEnvironment(env);
    return {
      mode,
      build: ["pnpm", ["build"]],
      command: process.execPath,
      args: [path.join(repositoryRoot, "dist", "index.js"), ...argv],
      env: { ...mainEnv, NODE_ENV: "production", STEAMHARNESS_REPOSITORY_MODE: "main" },
    };
  }

  const { tsconfigPath, coreRoot, sharedRoot } = await prepareDevelopment({ root: repositoryRoot });
  const requireFromCli = createRequire(path.join(repositoryRoot, "package.json"));
  const tsxCliPath = requireFromCli.resolve("tsx/cli");
  return {
    mode,
    command: process.execPath,
    args: [tsxCliPath, "--tsconfig", tsconfigPath, path.join(repositoryRoot, "src", "index.ts"), ...argv],
    env: {
      ...env,
      TSX_TSCONFIG_PATH: tsconfigPath,
      STEAMHARNESS_LOCAL_CORE_ROOT: coreRoot,
      STEAMHARNESS_LOCAL_SHARED_ROOT: sharedRoot,
      STEAMHARNESS_LOCAL_SOURCE_MODE: "1",
    },
  };
}

function withoutLocalSourceEnvironment(env) {
  const result = { ...env };
  for (const key of [
    "TSX_TSCONFIG_PATH",
    "STEAMHARNESS_LOCAL_CORE_ROOT",
    "STEAMHARNESS_LOCAL_SHARED_ROOT",
    "STEAMHARNESS_LOCAL_SOURCE_MODE",
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

async function main() {
  const plan = await createCliRunPlan({ argv: process.argv.slice(2) });
  await prepareSharedPackages({ root, env: plan.env });
  process.stdout.write(`[repository:${plan.mode}] CLI ${plan.mode === "dev" ? "source" : "dist"} runtime\n`);
  if (plan.build !== undefined) await run(plan.build[0], plan.build[1], { cwd: root, env: plan.env });
  const result = await run(plan.command, plan.args, { cwd: root, env: plan.env });
  process.exitCode = result;
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
