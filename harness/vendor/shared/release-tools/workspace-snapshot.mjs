import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGitAuthenticationEnv } from "./alpha-release.mjs";
import { resolveGitLabServerUrl } from "./alpha-dependencies.mjs";

export async function updateWorkspaceAlphaSnapshot(options) {
  if (!/^[0-9a-f]{40}$/iu.test(options.commitSha)) throw new Error(`Invalid child commit SHA: ${options.commitSha}`);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(options.submodule)) throw new Error(`Invalid submodule path: ${options.submodule}`);
  const runCommand = options.runCommand ?? run;
  const attempts = options.attempts ?? 5;
  const remote = `${resolveGitLabServerUrl(options.serverUrl)}/${options.workspaceProject}.git`;
  const gitEnv = createGitAuthenticationEnv(options.token, options.tokenUsername);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const checkout = await mkdtemp(path.join(os.tmpdir(), "workflow-alpha-workspace-"));
    try {
      await runCommand("git", ["clone", "--branch", "alpha", "--depth", "1", remote, checkout], {
        cwd: process.cwd(),
        env: gitEnv,
      });
      await runCommand("git", ["update-index", "--add", "--cacheinfo", `160000,${options.commitSha},${options.submodule}`], {
        cwd: checkout,
      });
      const status = await runCommand("git", ["status", "--porcelain"], { cwd: checkout, capture: true });
      if (status.trim() === "") return { changed: false, commitSha: options.commitSha };
      await runCommand("git", ["config", "user.name", "Workflow Alpha Release"], { cwd: checkout });
      await runCommand("git", ["config", "user.email", "workflow-alpha@localhost"], { cwd: checkout });
      await runCommand("git", ["commit", "-m", `chore: update ${options.submodule} alpha snapshot`], { cwd: checkout });
      await runCommand("git", ["push", ...(options.skipCi ? ["-o", "ci.skip"] : []), "origin", "HEAD:alpha"], {
        cwd: checkout,
        env: gitEnv,
        capture: true,
      });
      return { changed: true, commitSha: options.commitSha };
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !/rejected|fetch first|non-fast-forward|failed to push/u.test(String(error))) throw error;
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }
  throw lastError;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)));
  });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--skip-ci") {
      result.skipCi = true;
      continue;
    }
    if (["--workspace-project", "--submodule", "--commit-sha"].includes(token)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${token} requires a value.`);
      result[token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  result.workspaceProject ||= `${process.env.CI_PROJECT_NAMESPACE || "workflow"}/workspace`;
  result.commitSha ||= process.env.CI_COMMIT_SHA;
  if (!result.submodule || !result.commitSha) {
    throw new Error("Usage: workspace-snapshot.mjs --submodule <name> --commit-sha <sha>.");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await updateWorkspaceAlphaSnapshot(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
