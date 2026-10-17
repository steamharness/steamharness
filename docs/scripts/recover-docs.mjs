import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deployDocs } from "./deploy-docs.mjs";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export function parseDocsDeploymentMetadata(value) {
  if (!value || value.schemaVersion !== 1 || !COMMIT_PATTERN.test(String(value.commitSha ?? ""))) {
    throw new Error("Docs deployment record does not contain an exact commit SHA.");
  }
  return { commitSha: value.commitSha };
}

export async function recoverDocs(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(import.meta.dirname, ".."));
  const deployRootRaw = String(options.deployRoot ?? process.env.WORKFLOW_DOCS_DEPLOY_ROOT ?? "").trim();
  if (!deployRootRaw || !path.isAbsolute(deployRootRaw)) {
    throw new Error("WORKFLOW_DOCS_DEPLOY_ROOT must be a non-root absolute path.");
  }
  const deployRoot = path.resolve(deployRootRaw);
  if (deployRoot === path.parse(deployRoot).root) {
    throw new Error("WORKFLOW_DOCS_DEPLOY_ROOT must be a non-root absolute path.");
  }
  const deployment = parseDocsDeploymentMetadata(JSON.parse(await readFile(path.join(deployRoot, "deployment.json"), "utf8")));
  const execute = options.runCommand ?? runCommand;
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-docs-recovery-"));
  const sourceRoot = path.join(workRoot, "source");
  const env = { ...process.env, ...(options.env ?? {}), CI_COMMIT_SHA: deployment.commitSha };

  try {
    await ensureCommit(repoRoot, deployment.commitSha, execute, env);
    await execute("git", ["worktree", "add", "--detach", sourceRoot, deployment.commitSha], { cwd: repoRoot, env });
    await execute("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: sourceRoot, env });
    await execute("corepack", ["pnpm", "build"], { cwd: sourceRoot, env });
    return await deployDocs({
      sourceDir: path.join(sourceRoot, "dist", "site"),
      deployRoot,
      commitSha: deployment.commitSha,
    });
  } finally {
    await execute("git", ["worktree", "remove", "--force", sourceRoot], { cwd: repoRoot, env }).catch(() => undefined);
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function ensureCommit(repoRoot, commitSha, execute, env) {
  try {
    await execute("git", ["cat-file", "-e", `${commitSha}^{commit}`], { cwd: repoRoot, env });
  } catch {
    await execute("git", ["fetch", "origin", "--no-tags", commitSha], { cwd: repoRoot, env });
    await execute("git", ["cat-file", "-e", `${commitSha}^{commit}`], { cwd: repoRoot, env });
  }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await recoverDocs();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
