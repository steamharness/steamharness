import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const SKIP_ENVIRONMENT_VARIABLE = "STEAMHARNESS_SKIP_SIBLING_BOOTSTRAP";

/**
 * Development run plans execute sibling checkouts directly, so a sibling that
 * was never installed fails at startup. The failure is silent on Desktop:
 * the CLI exits without writing a structure report, the preview parses as
 * empty, and a Conversation project degrades to the Workflow panel with no
 * entrypoints instead of reporting an error. Repairing the siblings before the
 * plan starts keeps a partial checkout from reading as a broken project.
 */

export function shouldSkipSiblingInstalls(env = process.env) {
  const value = String(env[SKIP_ENVIRONMENT_VARIABLE] ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * A sibling is ready when its dependencies are installed. Everything they share
 * is resolved through the repository workspace, so there is no prepared copy of
 * Shared left to verify.
 */
export function isSiblingPrepared(siblingRoot) {
  return existsSync(path.join(siblingRoot, "node_modules"));
}

export async function readSiblingManifest(siblingRoot) {
  try {
    return JSON.parse(await readFile(path.join(siblingRoot, "package.json"), "utf8"));
  } catch {
    throw new Error(`Required sibling repository is missing package.json: ${siblingRoot}`);
  }
}

export function createSiblingInstallInvocation() {
  return { command: "pnpm", args: ["install"] };
}

export async function ensureSiblingInstalls({
  roots: siblingRoots = [],
  env = process.env,
  run = runCommand,
  log = defaultLog,
} = {}) {
  const installed = [];
  if (shouldSkipSiblingInstalls(env)) return { installed, skipped: true };

  for (const siblingRoot of siblingRoots) {
    await readSiblingManifest(siblingRoot);
    if (isSiblingPrepared(siblingRoot)) continue;
    const invocation = createSiblingInstallInvocation();
    log(`[siblings] ${path.basename(siblingRoot)} is not bootstrapped; running ${invocation.args.join(" ")}`);
    await run(invocation.command, invocation.args, { cwd: siblingRoot, env });
    installed.push({ root: siblingRoot, ...invocation });
  }
  return { installed, skipped: false };
}

function defaultLog(message) {
  process.stdout.write(`${message}\n`);
}

function runCommand(command, args, options) {
  const invocation = createInvocation(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) return reject(new Error(`${command} ${args.join(" ")} stopped by ${signal}.`));
      if (code !== 0) return reject(new Error(`${command} ${args.join(" ")} exited ${code ?? 1} in ${options.cwd}.`));
      resolve();
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
  const names = process.argv.slice(2).filter((token) => token !== "--");
  if (names.length === 0) {
    process.stderr.write("Usage: node scripts/ensure-siblings.mjs <sibling-directory>...\n");
    process.exitCode = 1;
  } else {
    ensureSiblingInstalls({ roots: names.map((name) => path.resolve(root, "..", name)) }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
