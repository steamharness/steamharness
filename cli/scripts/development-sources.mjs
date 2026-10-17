import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRepositoryMode } from "./repository-mode.mjs";

export async function prepareDevelopmentSources({
  root = path.resolve(import.meta.dirname, ".."),
  coreRoot = path.resolve(root, "..", "core"),
  sharedRoot = path.resolve(root, "..", "shared"),
} = {}) {
  await Promise.all([
    assertPackage(coreRoot, "steamharness"),
    assertPackage(sharedRoot, "@steamharness/shared-workspace"),
  ]);
  if (resolveRepositoryMode({ root: coreRoot, env: {} }) !== "dev") {
    throw new Error(`Local Core source must be on a development branch: ${coreRoot}`);
  }
  if (resolveRepositoryMode({ root: sharedRoot, env: {} }) !== "dev") {
    throw new Error(`Local Shared source must be on a development branch: ${sharedRoot}`);
  }

  const outputRoot = path.join(root, ".workflow-local");
  const tsconfigPath = path.join(outputRoot, "tsconfig.json");
  const sharedPaths = await createSharedCompilerPaths(sharedRoot);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(tsconfigPath, `${JSON.stringify({
    extends: path.join(root, "tsconfig.json"),
    compilerOptions: {
      baseUrl: root,
      paths: {
        ...sharedPaths,
        "steamharness": [path.join(coreRoot, "src", "index.ts")],
        "steamharness/*": [path.join(coreRoot, "src", "*")],
      },
    },
  }, null, 2)}\n`);

  return { coreRoot, sharedRoot, tsconfigPath };
}

export async function createSharedCompilerPaths(sharedRoot) {
  const paths = {};
  for (const entry of await readdir(sharedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(sharedRoot, entry.name, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@steamharness/")) continue;
    const packageRoot = path.join(sharedRoot, entry.name);
    const entrypoint = typeof manifest.types === "string" ? manifest.types : manifest.main;
    if (typeof entrypoint !== "string") continue;
    paths[manifest.name] = [path.resolve(packageRoot, entrypoint)];
    paths[`${manifest.name}/*`] = [path.join(packageRoot, "*")];
  }
  return Object.fromEntries(Object.entries(paths).sort(([left], [right]) => left.localeCompare(right)));
}

async function assertPackage(root, expectedName) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    throw new Error(`Required sibling repository is missing: ${root}`);
  }
  if (manifest.name !== expectedName) {
    throw new Error(`Expected ${expectedName} at ${root}.`);
  }
}
