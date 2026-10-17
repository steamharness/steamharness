import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

export function loadCliEnv(): void {
  const cliRoot = process.cwd();
  const defaultRepoRoot = findWorkspaceRepositoryRoot(cliRoot) ?? cliRoot;
  const initialRepoRoot = process.env.WORKFLOW_REPO_ROOT
    ? path.resolve(process.env.WORKFLOW_REPO_ROOT)
    : defaultRepoRoot;

  loadEnvFiles([
    path.join(cliRoot, ".env"),
    path.join(initialRepoRoot, ".env"),
  ]);

  const resolvedRepoRoot = process.env.WORKFLOW_REPO_ROOT
    ? path.resolve(process.env.WORKFLOW_REPO_ROOT)
    : initialRepoRoot;

  if (resolvedRepoRoot !== initialRepoRoot) {
    loadEnvFiles([path.join(resolvedRepoRoot, ".env")]);
  }
}

export function findWorkspaceRepositoryRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);

  while (true) {
    if (
      existsSync(path.join(current, "pnpm-workspace.yaml")) &&
      existsSync(path.join(current, "package.json")) &&
      existsSync(path.join(current, "workspace", "package.json")) &&
      existsSync(path.join(current, "workspace", "workflow"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function loadEnvFiles(filePaths: string[]): void {
  for (const filePath of unique(filePaths)) {
    if (!existsSync(filePath)) {
      continue;
    }

    const values = parse(readFileSync(filePath));

    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
