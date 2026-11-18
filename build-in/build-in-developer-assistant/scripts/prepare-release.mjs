import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { validateReleasePair } from "../../../docs/scripts/release-notes.mjs";

/**
 * Which release channel this preparation targets. `alpha` publishes the same
 * project version from the Alpha branch under its own tag namespace; the
 * stable release of a promoted version is a tag-only step, because the version
 * and the version documentation already arrived with the promotion.
 */
function normalizeChannel(value) {
  const channel = String(value ?? "").trim() || "stable";
  if (channel !== "stable" && channel !== "alpha") {
    throw new Error(`Built-in release channel must be stable or alpha, received ${channel}.`);
  }
  return channel;
}

export function releaseTag(projectId, version, channel) {
  return `builtin-${projectId}/${channel === "alpha" ? "alpha/" : ""}v${version}`;
}

export async function prepareRelease(options) {
  const root = path.resolve(options.root);
  const channel = normalizeChannel(options.channel);
  const version = String(options.version ?? "").trim();
  if (!semver.valid(version) || semver.prerelease(version)) {
    throw new Error("Release version must be a stable X.Y.Z SemVer.");
  }
  const manifestPath = path.join(root, "steamharness.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const projectId = String(manifest?.builtinRelease?.projectId ?? "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId)) {
    throw new Error("steamharness.json.builtinRelease.projectId is invalid.");
  }
  if (!semver.valid(manifest.version) || !semver.gt(version, manifest.version)) {
    throw new Error(`${version} must be greater than ${manifest.version}.`);
  }
  const docsPaths = validateReleasePair(options.docsRoot ?? path.join(root, "../../docs"), `builtin-${projectId}`, version);
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  return { docsPaths, projectId, version, channel, tag: releaseTag(projectId, version, channel) };
}

function parseArgs(argv) {
  let version;
  let channel;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--version") {
      version = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--channel") {
      channel = argv[index + 1];
      index += 1;
      continue;
    }
    if (!token.startsWith("--") && version === undefined) {
      version = token;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!version) throw new Error("Usage: pnpm release:prepare -- --version X.Y.Z [--channel alpha]");
  return { version, ...(channel === undefined ? {} : { channel }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await prepareRelease({
    root: path.resolve(import.meta.dirname, ".."),
    ...parseArgs(process.argv.slice(2)),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
