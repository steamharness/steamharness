import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import {
  appendHistory,
  assertHistoryParity,
  assertNextParity,
  parseNext,
  readHistoryVersions,
} from "../vendor/shared/release-tools/release-notes.mjs";

export async function prepareRelease(options) {
  const root = path.resolve(options.root);
  const version = String(options.version ?? "").trim();
  if (!semver.valid(version) || semver.prerelease(version)) {
    throw new Error("Release version must be a stable X.Y.Z SemVer.");
  }

  const manifestPath = path.join(root, "package.json");
  const zhHistoryPath = path.join(root, "CHANGELOG.md");
  const enHistoryPath = path.join(root, "CHANGELOG.en.md");
  const zhNextPath = path.join(root, "CHANGELOG.next.md");
  const enNextPath = path.join(root, "CHANGELOG.next.en.md");
  const paths = [manifestPath, zhHistoryPath, enHistoryPath, zhNextPath, enNextPath];
  const originals = new Map(await Promise.all(paths.map(async (filePath) => [
    filePath,
    await readFile(filePath, "utf8"),
  ])));
  const manifest = JSON.parse(originals.get(manifestPath));
  if (!semver.valid(manifest.version) || semver.lt(version, manifest.version)) {
    throw new Error(`${version} must not be lower than ${manifest.version}.`);
  }
  if (!semver.validRange(manifest.peerDependencies?.["workflow-code"])) {
    throw new Error("peerDependencies.workflow-code must be a valid SemVer range.");
  }
  const coreVersion = manifest.devDependencies?.["workflow-code"];
  const parsedCoreVersion = semver.parse(coreVersion);
  if (parsedCoreVersion === null || parsedCoreVersion.prerelease.length > 0) {
    throw new Error("devDependencies.workflow-code must be an exact stable SemVer version.");
  }
  const corePeerRange = `>=${parsedCoreVersion.major}.${parsedCoreVersion.minor}.0 `
    + `<${parsedCoreVersion.major}.${parsedCoreVersion.minor + 1}.0`;

  const zhHistory = originals.get(zhHistoryPath);
  const enHistory = originals.get(enHistoryPath);
  assertHistoryParity(zhHistory, enHistory);
  if (readHistoryVersions(zhHistory).some((release) => release.version === version)) {
    throw new Error(`${version} already exists in CHANGELOG.md.`);
  }
  const zhNext = parseNext(originals.get(zhNextPath), "zh-CN");
  const enNext = parseNext(originals.get(enNextPath), "en");
  assertNextParity(zhNext, enNext);
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const updates = new Map([
    [manifestPath, `${JSON.stringify({
      ...manifest,
      version,
      peerDependencies: {
        ...manifest.peerDependencies,
        "workflow-code": corePeerRange,
      },
    }, null, 2)}\n`],
    [zhHistoryPath, appendHistory(zhHistory, version, date, zhNext.body)],
    [enHistoryPath, appendHistory(enHistory, version, date, enNext.body)],
    [zhNextPath, "# Unreleased\n"],
    [enNextPath, "# Unreleased\n"],
  ]);

  try {
    for (const filePath of paths) await writeFile(filePath, updates.get(filePath), "utf8");
  } catch (error) {
    await Promise.all([...originals].map(([filePath, contents]) => writeFile(filePath, contents, "utf8")));
    throw error;
  }

  return { unit: "workflow-code-cli", version, tag: `workflow-code-cli/v${version}` };
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
