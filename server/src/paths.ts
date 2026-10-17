import { existsSync } from "node:fs";
import path from "node:path";

export interface ServerPathRoots {
  repoRoot: string;
  serverRoot: string;
}

export function resolveServerPathRoots(): ServerPathRoots {
  const repoRoot = process.env.WORKFLOW_REPO_ROOT
    ? path.resolve(process.env.WORKFLOW_REPO_ROOT)
    : findRepoRoot(process.cwd());
  const serverRoot = repoRoot;

  return { repoRoot, serverRoot };
}

function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    if (
      existsSync(path.join(current, "pnpm-workspace.yaml")) &&
      existsSync(path.join(current, "package.json")) &&
      existsSync(path.join(current, "web", "package.json"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }

    current = parent;
  }
}
