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

const UNIT_DEFINITIONS = Object.freeze({
  server: { directory: ".", tagPrefix: "server" },
  "server-web": { directory: "web", tagPrefix: "server-web" },
});

export async function prepareRelease(options) {
  const definition = UNIT_DEFINITIONS[options.unit];
  if (!definition) {
    throw new Error(`Unsupported release unit: ${options.unit ?? ""}.`);
  }
  if (!semver.valid(options.version) || semver.prerelease(options.version)) {
    throw new Error("Release version must be a stable X.Y.Z SemVer.");
  }

  const root = path.resolve(options.root);
  const unitRoot = path.resolve(root, definition.directory);
  const manifestPath = path.join(unitRoot, "package.json");
  const paths = [
    manifestPath,
    path.join(unitRoot, "CHANGELOG.md"),
    path.join(unitRoot, "CHANGELOG.en.md"),
    path.join(unitRoot, "CHANGELOG.next.md"),
    path.join(unitRoot, "CHANGELOG.next.en.md"),
  ];
  const originals = new Map(await Promise.all(paths.map(async (filePath) => [
    filePath,
    await readFile(filePath, "utf8"),
  ])));

  const manifest = JSON.parse(originals.get(manifestPath));
  if (!semver.valid(manifest.version) || semver.lt(options.version, manifest.version)) {
    throw new Error(`${options.version} must not be lower than ${manifest.version}.`);
  }

  const zhHistoryPath = path.join(unitRoot, "CHANGELOG.md");
  const enHistoryPath = path.join(unitRoot, "CHANGELOG.en.md");
  const zhNextPath = path.join(unitRoot, "CHANGELOG.next.md");
  const enNextPath = path.join(unitRoot, "CHANGELOG.next.en.md");
  const zhHistory = originals.get(zhHistoryPath);
  const enHistory = originals.get(enHistoryPath);
  const zhNext = parseNext(originals.get(zhNextPath), "zh-CN");
  const enNext = parseNext(originals.get(enNextPath), "en");
  assertHistoryParity(zhHistory, enHistory);
  assertNextParity(zhNext, enNext);
  if (readHistoryVersions(zhHistory).some((release) => release.version === options.version)) {
    throw new Error(`${options.unit} ${options.version} already exists in CHANGELOG.md.`);
  }

  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const nextContents = new Map([
    [manifestPath, `${JSON.stringify({ ...manifest, version: options.version }, null, 2)}\n`],
    [zhHistoryPath, appendHistory(zhHistory, options.version, date, zhNext.body)],
    [enHistoryPath, appendHistory(enHistory, options.version, date, enNext.body)],
    [zhNextPath, "# Unreleased\n"],
    [enNextPath, "# Unreleased\n"],
  ]);

  try {
    for (const filePath of paths) {
      await writeFile(filePath, nextContents.get(filePath), "utf8");
    }
  } catch (error) {
    await Promise.all([...originals].map(([filePath, contents]) => writeFile(filePath, contents, "utf8")));
    throw error;
  }

  return {
    unit: options.unit,
    version: options.version,
    tag: `${definition.tagPrefix}/v${options.version}`,
  };
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--unit" || arg === "--version") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.unit || !options.version) {
    throw new Error("Usage: pnpm release:prepare -- --unit <server|server-web> --version X.Y.Z");
  }
  return options;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  const root = path.resolve(import.meta.dirname, "..");
  const result = await prepareRelease({ root, ...parseCliArgs(process.argv.slice(2)) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
