import { existsSync } from "node:fs";
import path from "node:path";

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
