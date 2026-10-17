import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createStableReleaseDefinition } from "./deploy-stable.mjs";

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-\d{11})?$/u;

export async function buildRuntime(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(import.meta.dirname, ".."));
  const channel = String(options.channel ?? "").trim();
  const version = String(options.version ?? "").trim();
  const commitSha = String(options.commitSha ?? process.env.CI_COMMIT_SHA ?? "").trim().toLowerCase();
  if (!new Set(["stable", "alpha"]).has(channel)) throw new Error("Runtime channel must be stable or alpha.");
  if (!VERSION_PATTERN.test(version)) throw new Error("Runtime version must be a stable or Alpha version.");
  if (!COMMIT_PATTERN.test(commitSha)) throw new Error("Runtime artifact requires an exact commit SHA.");
  const output = path.resolve(options.output ?? path.join(repoRoot, ".release", `workflow-server-${channel}-${version}.tgz`));
  const workRoot = await fsTempDirectory("workflow-runtime-");
  const staging = path.join(workRoot, "runtime");
  try {
    await execFileAsync("corepack", ["pnpm", "--filter", "@steamharness/server", "deploy", "--prod", "--legacy", staging], {
      cwd: repoRoot,
      env: options.env ?? process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    const keep = new Set(["node_modules", ".shared", "package.json", "assets", "CHANGELOG.md", "CHANGELOG.en.md"]);
    for (const name of await readdir(staging)) {
      if (!keep.has(name)) await rm(path.join(staging, name), { recursive: true, force: true });
    }
    for (const directory of ["dist", "public"]) await cp(path.join(repoRoot, directory), path.join(staging, directory), { recursive: true });
    await execFileAsync(process.execPath, ["--input-type=module", "-e", "await import('pg'); await import('steamharness');"], { cwd: staging, maxBuffer: 1024 * 1024 });
    await mkdir(path.join(staging, "web"), { recursive: true });
    await cp(path.join(repoRoot, "web", "package.json"), path.join(staging, "web", "package.json"));
    await mkdir(path.join(staging, ".node", "bin"), { recursive: true });
    await cp(process.execPath, path.join(staging, ".node", "bin", "node"));
    await chmod(path.join(staging, ".node", "bin", "node"), 0o755);
    const build = JSON.parse(await readFile(path.join(staging, "dist", "build-info.json"), "utf8"));
    assert.equal(build.commitSha, commitSha, "Runtime build commit does not match the requested release");
    assert.equal(build.productVersion, version, "Runtime version does not match the requested release");
    const runtime = {
      schemaVersion: 1,
      channel,
      version,
      commitSha,
      builtAt: options.builtAt ?? process.env.CI_COMMIT_TIMESTAMP ?? new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
    };
    await writeFile(path.join(staging, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
    if (channel === "alpha") {
      await writeFile(path.join(staging, "alpha-release.json"), `${JSON.stringify({ ...runtime, publishedAt: runtime.builtAt }, null, 2)}\n`);
    }
    const stable = channel === "stable" ? await createStableReleaseDefinition({ repoRoot, version, commitSha, publishedAt: runtime.builtAt }) : null;
    for (const unit of ["server", "server-web"]) {
      const directory = path.join(staging, ".release-metadata", unit, channel);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "release.json"), `${JSON.stringify(stable?.releases[unit] ?? {
        unit, channel, tag: `${channel === "alpha" ? "alpha" : unit}/v${version}`,
        version, commitSha, publishedAt: runtime.builtAt,
        components: { core: build.coreVersion, server: version },
      }, null, 2)}\n`);
    }
    await mkdir(path.dirname(output), { recursive: true });
    await execFileAsync("tar", ["-czf", output, "-C", staging, "."], { cwd: repoRoot });
    return { ...runtime, output, releaseId: `server-${channel}-${version}-${commitSha.slice(0, 12)}` };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function fsTempDirectory(prefix) {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!["--channel", "--version", "--commit-sha", "--output"].includes(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}.`);
    options[token.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildRuntime({ repoRoot: path.resolve(import.meta.dirname, ".."), ...parseArgs(process.argv.slice(2)) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
