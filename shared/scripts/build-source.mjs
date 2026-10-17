import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(repoRoot, "dist", "source");
const ignoredDirectories = new Set([".agents", ".claude", ".codex", ".git", "coverage", "dist", "node_modules", "scripts", "tests"]);
// Owned by another repository: the run workspace UI now lives in
// desktop/packages/run-workspace-input. Listed explicitly so a stray directory
// with this name cannot silently start shipping to every consumer again.
const packagesOwnedElsewhere = new Set(["run-workspace-input"]);
const packageDirectories = (await readdir(repoRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()
    && !ignoredDirectories.has(entry.name)
    && !packagesOwnedElsewhere.has(entry.name))
  .map((entry) => entry.name)
  .sort();

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const packageDirectory of packageDirectories) {
  await cp(path.join(repoRoot, packageDirectory), path.join(outputRoot, packageDirectory), {
    recursive: true,
    filter(source) {
      const relative = path.relative(path.join(repoRoot, packageDirectory), source);
      return !relative.split(path.sep).some((segment) => segment === "__tests__" || segment === "node_modules");
    },
  });
}

process.stdout.write(`Built ${packageDirectories.length} shared source packages in ${outputRoot}\n`);
