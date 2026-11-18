import fs from "node:fs/promises";
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
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!semver.valid(manifest.version) || version !== manifest.version) {
    throw new Error(`Core package.json must be changed to ${version} before release preparation (found ${manifest.version}).`);
  }

  const docsPaths = validateReleasePair(options.docsRoot ?? path.join(root, "../docs"), "core", version);

  return {
    docsPaths,
    unit: "steamharness",
    version,
    tag: `steamharness/v${version}`,
    synchronizedPackages: [],
  };
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
