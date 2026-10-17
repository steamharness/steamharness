import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareSharedPackages } from "./prepare-shared.mjs";

const root = path.resolve(import.meta.dirname, "..");

export async function bootstrapRepository({
  root: repositoryRoot = root,
  env = process.env,
  argv = [],
  prepare = prepareSharedPackages,
  install = runInstall,
} = {}) {
  await prepare({ root: repositoryRoot, env: { ...env, WORKFLOW_REPOSITORY_MODE: "main" } });
  return install({ root: repositoryRoot, env, argv });
}

function runInstall({ root: repositoryRoot, env, argv }) {
  const invocation = createInvocation(["install", ...argv]);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: repositoryRoot, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) return reject(new Error(`pnpm install stopped by ${signal}.`));
      if (code !== 0) return reject(new Error(`pnpm install exited with code ${code ?? 1}.`));
      resolve(0);
    });
  });
}

function createInvocation(args) {
  if (process.platform === "win32") {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", ...args] };
  }
  return { command: "pnpm", args };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  bootstrapRepository({ argv: process.argv.slice(2).filter((token) => token !== "--") }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
