import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

register();
const { assertRepositoryBoundaries, scanRepositoryBoundaries } = await import("../repository-boundary/index.ts");

export async function checkRepositoryBoundaries({ root = process.cwd() } = {}) {
  const violations = await scanRepositoryBoundaries(path.resolve(root));
  assertRepositoryBoundaries(violations);
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootArgIndex = process.argv.indexOf("--root");
  const root = rootArgIndex >= 0 ? process.argv[rootArgIndex + 1] : process.cwd();
  if (!root) throw new Error("--root requires a repository path.");
  await checkRepositoryBoundaries({ root });
  process.stdout.write(`Repository boundary check passed: ${path.resolve(root)}\n`);
}
