import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildRuntime } from "./build-runtime.mjs";
import { buildEcsEnv } from "./write-ecs-env.mjs";
import { deployEcs } from "./deploy-ecs.mjs";

const exec = promisify(execFile);

export function parseImmutableRef(ref) {
  const match = /^(server-web|alpha)\/v(\d+\.\d+\.\d+(?:-\d{11})?)$/u.exec(ref ?? "");
  if (!match || (match[1] === "alpha") !== match[2].includes("-")) throw new Error("Use an immutable server-web/vX.Y.Z or alpha/vX.Y.Z-YYYYMMDDNNN tag.");
  return { channel: match[1] === "alpha" ? "alpha" : "stable", version: match[2] };
}

export async function recoverArtifact() {
  const ref = process.env.STEAMHARNESS_RUNTIME_REF;
  const { channel, version } = parseImmutableRef(ref);
  if ((channel === "alpha" ? "alpha" : "production") !== process.env.CI_ENVIRONMENT_NAME) throw new Error("Artifact channel does not match the protected CI environment.");
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build ECS artifacts on the Linux x64 Runner.");
  const temp = await mkdtemp(path.join(os.tmpdir(), "steamharness-immutable-runtime-"));
  try {
    const checkout = path.join(temp, "source");
    const repository = String((await exec("git", ["remote", "get-url", "origin"])).stdout).trim();
    // Do not print the repository URL: CI embeds its job credential in it.
    await exec("git", ["clone", "--quiet", "--depth", "1", "--branch", ref, repository, checkout]).catch(() => { throw new Error("Cannot clone the immutable recovery tag."); });
    const sha = String((await exec("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout).trim();
    const env = { ...process.env, CI_COMMIT_SHA: sha, STEAMHARNESS_REPOSITORY_MODE: "main" };
    await run("corepack", ["pnpm", "install", "--frozen-lockfile"], checkout, env);
    if (channel === "alpha") await run(process.execPath, ["vendor/shared/release-tools/alpha-release.mjs", "write", "--version", version, "--manifest", "package.json", "--manifest", "web/package.json"], checkout, env);
    await run("corepack", ["pnpm", "build:all"], checkout, env);
    const manifest = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
    if (manifest.version !== version) throw new Error("Immutable tag and manifest version differ.");
    const output = path.join(process.cwd(), ".release", `server-${channel}-${version}-runtime.tgz`);
    const artifact = await buildRuntime({ repoRoot: checkout, channel, version, commitSha: sha, output, env });
    const envFile = path.join(temp, "runtime.env");
    await writeFile(envFile, buildEcsEnv({ kind: channel }), { mode: 0o600 });
    process.env[channel === "alpha" ? "STEAMHARNESS_ALPHA_RUNTIME_ENV_FILE" : "STEAMHARNESS_STABLE_RUNTIME_ENV_FILE"] = envFile;
    await deployEcs({ command: "prepare-images" });
    await deployEcs({ command: "deploy-server", channel, archive: output, releaseId: artifact.releaseId });
    return artifact;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Artifact preparation failed: ${command} exited ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(await recoverArtifact())}\n`);
}
