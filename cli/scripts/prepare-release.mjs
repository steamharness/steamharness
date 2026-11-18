import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { validateReleasePair } from "../../docs/scripts/release-notes.mjs";

export async function prepareRelease(options) {
  const root = path.resolve(options.root);
  const version = String(options.version ?? "").trim();
  if (!semver.valid(version) || semver.prerelease(version)) {
    throw new Error("Release version must be a stable X.Y.Z SemVer.");
  }

  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!semver.valid(manifest.version) || semver.lt(version, manifest.version)) {
    throw new Error(`${version} must not be lower than ${manifest.version}.`);
  }
  if (!semver.validRange(manifest.peerDependencies?.["steamharness"])) {
    throw new Error("peerDependencies.steamharness must be a valid SemVer range.");
  }
  const coreVersion = manifest.devDependencies?.["steamharness"];
  const parsedCoreVersion = semver.parse(coreVersion);
  if (parsedCoreVersion === null || parsedCoreVersion.prerelease.length > 0) {
    throw new Error("devDependencies.steamharness must be an exact stable SemVer version.");
  }
  if (coreVersion !== version) {
    throw new Error("Core and CLI versions must match; update the exact Core dependency before preparing the release.");
  }

  const docsPaths = validateReleasePair(options.docsRoot ?? path.join(root, "../docs"), "cli", version);
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version, peerDependencies: { ...manifest.peerDependencies, steamharness: coreVersion } }, null, 2)}\n`);
  return { docsPaths, unit: "steamharness-cli", version, tag: `steamharness/v${version}` };
}

function parseArgs(argv) {
  let version;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--version") {
      version = argv[index + 1];
      index += 1;
      continue;
    }
    if (!token.startsWith("--") && version === undefined) {
      version = token;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!version) throw new Error("Usage: pnpm release:prepare -- --version X.Y.Z");
  return { version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await prepareRelease({
    root: path.resolve(import.meta.dirname, ".."),
    ...parseArgs(process.argv.slice(2)),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
