import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

export async function assertIsolatedInstall({ root: repositoryRoot = root } = {}) {
  const sharedRoot = path.join(repositoryRoot, ".shared");
  let entries;
  try {
    entries = await readdir(sharedRoot);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error("Shared packages are not prepared. Run pnpm bootstrap instead of pnpm install.");
    }
    throw error;
  }
  for (const entry of entries) {
    if ((await lstat(path.join(sharedRoot, entry))).isSymbolicLink()) {
      throw new Error("Direct install is disabled while Shared source links are active. Run pnpm bootstrap.");
    }
  }
}

function isMissingPathError(error) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assertIsolatedInstall().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
