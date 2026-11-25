import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { Parser } from "tar";
import {
  BUNDLED_PROJECT_RUNTIME_FILES, normalizeExactVersion, projectBundlesRuntime,
  STEAMHARNESS_CLI_PACKAGE_NAME, STEAMHARNESS_HARNESS_PACKAGE_NAME,
} from "./index";

const archiveLimit = 128 * 1024 * 1024;
const expandedLimit = 512 * 1024 * 1024;
const manifestLimit = 256 * 1024;

async function readArchiveManifest(root: string, relative: string, name: string, signal?: AbortSignal) {
  try {
    const file = path.join(root, relative);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > archiveLimit || await realpath(file) !== file) {
      throw new Error("Expected a regular archive inside the project.");
    }

    let found = false, expanded = 0;
    const chunks: Buffer[] = [];
    const deadline = AbortSignal.timeout(10_000);
    await new Promise<void>((resolve, reject) => {
      const input = createReadStream(file, { signal: signal ? AbortSignal.any([deadline, signal]) : deadline });
      // Examine the npm package manifest only; do not extract or execute archive entries.
      const parser = new Parser({ strict: true, maxMetaEntrySize: manifestLimit, maxDecompressionRatio: 100,
        onReadEntry(entry) {
          expanded += entry.size + 512;
          if (!Number.isSafeInteger(expanded) || expanded > expandedLimit) {
            parser.abort(new Error("Runtime archive is too large."));
            return;
          }
          if (entry.path === "package/package.json" || entry.path === "./package/package.json") {
            if (found || !["File", "OldFile"].includes(entry.type) || entry.size > manifestLimit) {
              parser.abort(new Error("Invalid archive package.json entry."));
              return;
            }
            found = true;
            entry.on("data", (chunk: Buffer) => chunks.push(chunk));
          }
          entry.resume();
        },
      });
      input.once("error", reject);
      parser.on("error", error => { input.destroy(); reject(error); });
      parser.once("end", resolve);
      input.pipe(parser);
    });
    if (!found) throw new Error("Archive has no package/package.json.");
    const pkg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (pkg?.name !== name || typeof pkg.version !== "string") throw new Error(`Expected manifest for ${name}.`);
    return { version: normalizeExactVersion(pkg.version, `${name} archive version`), readsArchiveManifest: pkg.steamharnessProjectRuntime === "archive-manifest" };
  } catch (cause) {
    signal?.throwIfAborted();
    throw new Error(`Cannot read the runtime package version from ${relative}.`, { cause });
  }
}

/** The tarballs are authoritative, including when an older project still has the legacy version field. */
export async function readBundledProjectRuntime(directory: string, manifest: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!projectBundlesRuntime(manifest)) return undefined;
  const root = await realpath(directory);
  const [core, cli] = await Promise.all([
    readArchiveManifest(root, BUNDLED_PROJECT_RUNTIME_FILES[0], STEAMHARNESS_HARNESS_PACKAGE_NAME, signal),
    readArchiveManifest(root, BUNDLED_PROJECT_RUNTIME_FILES[1], STEAMHARNESS_CLI_PACKAGE_NAME, signal),
  ]);
  if (core.version !== cli.version) throw new Error(`The bundled Core (${core.version}) and CLI (${cli.version}) versions do not match.`);
  return { version: core.version, cliReadsArchiveManifest: cli.readsArchiveManifest };
}
