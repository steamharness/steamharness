import path from "node:path";
import { register } from "tsx/esm/api";

const root = path.resolve(import.meta.dirname, "..");
const sharedRoot = path.resolve(root, "..", "shared");
register();
const { assertRepositoryBoundaries, scanRepositoryBoundaries } =
  await import("../../shared/repository-boundary/index.ts");
// Shared lives in this repository now, so the boundary scan covers the local
// packages directly instead of a prepared copy of them.
const violations = [
  ...await scanRepositoryBoundaries(root),
  ...await scanRepositoryBoundaries(sharedRoot),
];
assertRepositoryBoundaries(violations);
process.stdout.write(`Repository boundary check passed: ${root}\n`);
