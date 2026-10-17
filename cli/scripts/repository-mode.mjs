import { execFileSync } from "node:child_process";
import path from "node:path";

export function resolveRepositoryMode({
  root = path.resolve(import.meta.dirname, ".."),
  env = process.env,
  branch,
} = {}) {
  const override = env.STEAMHARNESS_REPOSITORY_MODE?.trim();
  if (override !== undefined && override !== "" && override !== "main") {
    throw new Error("STEAMHARNESS_REPOSITORY_MODE only accepts main as a fail-closed override.");
  }
  if (override === "main" || hasText(env.CI_COMMIT_TAG)) return "main";

  const resolvedBranch = firstText(env.CI_COMMIT_BRANCH, env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME)
    ?? (branch === undefined ? readGitBranch(root) : branch.trim() || undefined);
  return resolvedBranch !== undefined && resolvedBranch !== "main" ? "dev" : "main";
}

function readGitBranch(root) {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function firstText(...values) {
  return values.find(hasText)?.trim();
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}
