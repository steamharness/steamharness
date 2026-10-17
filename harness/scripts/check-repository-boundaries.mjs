import path from "node:path";
import { register } from "tsx/esm/api";
import { prepareSharedPackages } from "./prepare-shared.mjs";
import { resolveRepositoryMode } from "./repository-mode.mjs";

const root = path.resolve(import.meta.dirname, "..");
const prepared = await prepareSharedPackages({ root });
register();
const { assertRepositoryBoundaries, scanPreparedRepositoryMode, scanRepositoryBoundaries } =
  await import("../.shared/repository-boundary/index.ts");
const violations = [
  ...await scanRepositoryBoundaries(root),
  ...await scanPreparedRepositoryMode(root, resolveRepositoryMode({ root })),
];
assertRepositoryBoundaries(violations);
process.stdout.write(`Repository boundary check passed: ${root} (${prepared.mode}/${prepared.strategy})\n`);
