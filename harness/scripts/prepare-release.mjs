import fs from "node:fs/promises";
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
  const paths = [
    manifestPath,
    zhHistoryPath,
    enHistoryPath,
    zhNextPath,
    enNextPath,
  ];
  const snapshots = await captureSnapshots(paths);
  const manifest = JSON.parse(snapshots.get(manifestPath).toString("utf8"));
  if (!semver.valid(manifest.version) || version !== manifest.version) {
    throw new Error(`Core package.json must be changed to ${version} before release preparation (found ${manifest.version}).`);
  }

  const zhHistory = snapshots.get(zhHistoryPath).toString("utf8");
  const enHistory = snapshots.get(enHistoryPath).toString("utf8");
  assertHistoryParity(zhHistory, enHistory);
  if (readHistoryVersions(zhHistory).some((release) => release.version === version)) {
    throw new Error(`${version} already exists in CHANGELOG.md.`);
  }
  const zhNext = parseNext(snapshots.get(zhNextPath).toString("utf8"), "zh-CN");
  const enNext = parseNext(snapshots.get(enNextPath).toString("utf8"), "en");
  assertNextParity(zhNext, enNext);

  try {
    const date = options.date ?? new Date().toISOString().slice(0, 10);
    const updates = [
      [zhHistoryPath, appendHistory(zhHistory, version, date, zhNext.body)],
      [enHistoryPath, appendHistory(enHistory, version, date, enNext.body)],
      [zhNextPath, "# Unreleased\n"],
      [enNextPath, "# Unreleased\n"],
    ];
    // Finish each write before rollback can begin; concurrent writes could
    // otherwise complete after the original contents have been restored.
    for (const [filePath, contents] of updates) {
      await fs.writeFile(filePath, contents, "utf8");
    }
  } catch (error) {
    await restoreSnapshots(snapshots);
    throw error;
  }

  return {
    unit: "steamharness",
    version,
    tag: `steamharness/v${version}`,
    synchronizedPackages: [],
  };
}

async function captureSnapshots(paths) {
  const snapshots = new Map();
  for (const filePath of new Set(paths)) {
    try {
      snapshots.set(filePath, await fs.readFile(filePath));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      snapshots.set(filePath, undefined);
    }
  }
  return snapshots;
}

async function restoreSnapshots(snapshots) {
  for (const [filePath, contents] of snapshots) {
    if (contents === undefined) {
      await fs.rm(filePath, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
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
