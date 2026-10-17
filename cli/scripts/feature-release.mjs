#!/usr/bin/env node
// Feature-branch release channel.
//
// A feature branch has to be able to publish a CLI build: the built-in
// projects and hosts pin exact versions, so a fix that lives on `codex/*`
// cannot reach them until a version carrying it exists on npm, and waiting for
// the change to be merged into `dev` means the fix and its consumers are never
// tested together.
//
// The channel is deliberately separate from `dev` and `alpha`:
//
// - the version carries a branch marker — `<base>-<YYYYMMDDNNN>.<branch-slug>`,
//   e.g. `0.2.4-20260920001.codex-pi-agent` — so it can never collide with a
//   channel version of the same day and reads as what it is;
// - the tag is `feat/v<version>`, which is what the tag pipeline publishes
//   from, so a feature release runs the same validate → pack → publish
//   pipeline the channels do;
// - the dist-tag is `feat-<branch-slug>`, so no channel and no `latest` is ever
//   moved by a feature build.
//
// Nothing here touches `dev`, `alpha` or `main`, and no downstream repository is
// synchronized: the feature branch bumps the pins it needs itself.

import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const FEATURE_VERSION_PATTERN = /^(\d+\.\d+\.\d+)-(\d{8})(\d{3})\.([a-z0-9][a-z0-9.-]*)$/u;
const FEATURE_TAG_PATTERN = /^feat\/v(\d+\.\d+\.\d+-\d{11}\.[a-z0-9][a-z0-9.-]*)$/u;
const CHANNEL_BRANCHES = new Set(["main", "alpha", "dev"]);
const MAX_SEQUENCE = 999;

/** The Shanghai date the version sequence counts within, as YYYYMMDD. */
export function formatFeatureDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts.replaceAll("-", "");
}

/** The branch as it appears in a version and a dist-tag. */
export function formatBranchSlug(branch) {
  const slug = String(branch ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9.-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .replaceAll(/-{2,}/gu, "-");
  if (slug === "") throw new Error(`Branch name has no usable slug: ${branch}`);
  return slug;
}

/**
 * Versions already spent for one day, from every release prefix.
 *
 * A feature build shares the day's sequence with the channels — the counter is
 * global, so two builds of the same day can never carry the same number, which
 * is what npm would reject them for.
 */
export function parseFeatureVersions(tags, date) {
  const spent = [];
  for (const tag of tags ?? []) {
    const name = String(tag).replace(/^refs\/tags\//u, "");
    const flattened = name.includes("/v")
      ? name.split("/v").at(-1)
      : name.split("/").at(-1);
    const match = FEATURE_VERSION_PATTERN.exec(flattened) ?? /^(\d+\.\d+\.\d+)-(\d{8})(\d{3})$/u.exec(flattened);
    if (match === null || match[2] !== date) continue;
    spent.push({ version: flattened, base: match[1], sequence: Number(match[3]) });
  }
  return spent;
}

export function nextFeatureVersion(options) {
  const base = String(options.baseVersion ?? "").trim();
  if (!STABLE_VERSION_PATTERN.test(base)) {
    throw new Error(`Feature release base version is invalid: ${options.baseVersion}`);
  }
  const date = options.date ?? formatFeatureDate();
  const slug = formatBranchSlug(options.branch);
  const spent = parseFeatureVersions(options.tags, date);
  const highest = spent.reduce((current, entry) => Math.max(current, entry.sequence), 0);
  if (highest >= MAX_SEQUENCE) {
    throw new Error(`Feature release sequence for ${date} is exhausted (${highest}).`);
  }

  const sequence = String(highest + 1).padStart(3, "0");
  const version = `${base}-${date}${sequence}.${slug}`;
  return { version, tag: `feat/v${version}`, distTag: `feat-${slug}`.slice(0, 60), base, date, slug, sequence: highest + 1 };
}

export function readFeatureTag(tag) {
  const match = FEATURE_TAG_PATTERN.exec(String(tag ?? "").trim());
  if (match === null) {
    throw new Error(
      `Feature release tag is invalid: ${tag} (expected feat/v<X.Y.Z>-<YYYYMMDDNNN>.<branch-slug>).`,
    );
  }
  const version = match[1];
  const slug = version.split(".").at(-1);
  return { version, tag: `feat/v${version}`, distTag: `feat-${slug}`.slice(0, 60) };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(`${command} ${args.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function readBaseVersion(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  return String(manifest.version ?? "").trim();
}

async function readRemoteTags(root, remote, runCommand) {
  const output = await runCommand("git", ["ls-remote", "--tags", "--refs", remote], { cwd: root, capture: true });
  return String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u).at(-1) ?? "")
    .map((ref) => ref.replace(/^refs\/tags\//u, ""))
    .filter((ref) => ref !== "");
}

/** Creates and pushes the tag the pipeline publishes from. */
export async function tagFeatureRelease(options) {
  const root = path.resolve(options.root ?? process.cwd());
  const runCommand = options.runCommand ?? run;
  const remote = options.remote ?? "origin";
  const branch = options.branch
    ?? String(await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, capture: true })).trim();
  if (CHANNEL_BRANCHES.has(branch)) {
    throw new Error(`A feature release is not how "${branch}" publishes; use the channel pipeline.`);
  }

  const dirty = String(await runCommand("git", ["status", "--porcelain"], { cwd: root, capture: true })).trim();
  if (dirty !== "") {
    throw new Error("The working tree has uncommitted changes; a release must publish a commit that exists.");
  }

  const baseVersion = await readBaseVersion(root);
  const tags = await readRemoteTags(root, remote, runCommand);
  const planned = nextFeatureVersion({ baseVersion, branch, tags, date: options.date });
  if (options.dryRun === true) return { ...planned, pushed: false };

  const commitSha = String(await runCommand("git", ["rev-parse", "HEAD"], { cwd: root, capture: true })).trim();
  try {
    await runCommand("git", ["tag", planned.tag, commitSha], { cwd: root });
    await runCommand("git", ["push", remote, `refs/tags/${planned.tag}`], { cwd: root });
  } catch (error) {
    await runCommand("git", ["tag", "-d", planned.tag], { cwd: root }).catch(() => undefined);
    throw error;
  }

  return { ...planned, commitSha, pushed: true };
}

/**
 * Writes the feature version into the manifest, the way a channel release does.
 *
 * The shared release tooling owns the channel version shape and refuses
 * anything else, which is exactly why the feature channel carries its own
 * version: `<base>-<date><seq>.<slug>` is not a channel version and must never
 * be read as one.
 */
export async function writeFeatureVersion(options) {
  const root = path.resolve(options.root ?? process.cwd());
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = String(options.version ?? "").trim();
  const parsed = FEATURE_VERSION_PATTERN.exec(version);
  if (parsed === null) {
    throw new Error(`Feature release version is invalid: ${options.version}`);
  }
  if (parsed[1] !== String(manifest.version ?? "").trim()) {
    throw new Error(
      `Feature version base ${parsed[1]} does not match package.json (${String(manifest.version)}).`,
    );
  }

  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { packageName: manifest.name, version };
}

/**
 * Publishes an already-packed tarball.
 *
 * The shared release tooling publishes the channel versions and refuses a
 * version shape it does not own, so the feature channel carries its own two
 * steps: publish, then point its dist-tag at the result. Nothing else is
 * touched.
 */
export async function publishFeatureRelease(options) {
  const runCommand = options.runCommand ?? run;
  const packageName = String(options.packageName ?? "").trim();
  const version = String(options.version ?? "").trim();
  const distTag = String(options.distTag ?? "").trim();
  if (packageName === "" || version === "" || !/^[a-z][a-z0-9._-]*$/u.test(distTag)) {
    throw new Error(`Feature release inputs are invalid: ${packageName}@${version} (${distTag}).`);
  }
  const tarballDir = path.resolve(options.tarballDir ?? ".release/feature");
  const tarballPath = await resolveTarballPath(tarballDir);
  const existing = await readPublishedVersion({ packageName, version, runCommand });
  if (existing === "present") {
    throw new Error(`${packageName}@${version} is already published; a feature version is never reused.`);
  }
  if (existing === "unknown") {
    throw new Error(`Could not reach npm to check whether ${packageName}@${version} exists.`);
  }

  await runCommand("npm", ["publish", tarballPath, "--access", "public", "--tag", distTag]);
  await runCommand("npm", ["dist-tag", "add", `${packageName}@${version}`, distTag]);
  return { packageName, version, distTag, tarballPath };
}

/** The one tarball a release run packed; more than one means the wrong directory. */
async function resolveTarballPath(directory) {
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith(".tgz"));
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one packed tarball in ${directory}, found ${entries.length}.`);
  }
  return path.join(directory, entries[0]);
}

/** `present`, `missing`, or `unknown` when the registry could not be asked. */
async function readPublishedVersion({ packageName, version, runCommand }) {
  try {
    const output = await runCommand("npm", ["view", `${packageName}@${version}`, "version", "--json"], { capture: true });
    return String(output).trim() === "" ? "missing" : "present";
  } catch (error) {
    return /E404|No match found/iu.test(String(error?.message ?? error)) ? "missing" : "unknown";
  }
}

function parseArgs(argv) {
  const [command = ""] = argv;
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (["--root", "--remote", "--branch", "--date", "--tag", "--version", "--dist-tag", "--tarball-dir", "--package", "--output"].includes(token)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${token} requires a value.`);
      const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      options[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const root = path.resolve(options.root ?? process.cwd());

  if (options.command === "tag") {
    const result = await tagFeatureRelease({ root, remote: options.remote, branch: options.branch, date: options.date, dryRun: options.dryRun });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  if (options.command === "env") {
    const tag = options.tag ?? process.env.CI_COMMIT_TAG;
    const resolved = readFeatureTag(tag);
    const line = `FEATURE_VERSION=${resolved.version}\nFEATURE_DIST_TAG=${resolved.distTag}\n`;
    if (options.output !== undefined) {
      await writeFile(path.resolve(root, options.output), line, "utf8");
    } else {
      process.stdout.write(line);
    }
    return 0;
  }

  if (options.command === "version") {
    const result = await writeFeatureVersion({ root, version: options.version });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  if (options.command === "publish") {
    const result = await publishFeatureRelease({
      packageName: options.package ?? JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).name,
      version: options.version,
      distTag: options.distTag,
      tarballDir: options.tarballDir,
      runCommand: options.runCommand,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  throw new Error(`Unknown command: ${options.command} (expected tag, env or publish).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code ?? 0; },
    (error) => {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
