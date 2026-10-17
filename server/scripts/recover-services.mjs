import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertReleaseStorageRootWritable,
  loadProductionEnv,
  resolveReleasePaths,
  resolveReleaseStorageRoot,
} from "./release-storage.mjs";
import { findMissingProductionEnv } from "./check-production-env.mjs";

const DEFAULT_DOCKER_SOCKET_LOCATION = "/var/run/docker.sock";

export function createDockerRecoveryServices(serverRoot) {
  const dockerRoot = path.join(serverRoot, "docker");
  return [
    {
      name: "PostgreSQL",
      projectName: "workflow-code-postgres",
      projectDirectory: path.join(dockerRoot, "postgres"),
      files: ["docker-compose.yml", "docker-compose.release.yml"],
    },
  ];
}

export function validateRecoveryEnvironment(env = process.env) {
  const missing = findMissingProductionEnv(env);
  if (missing.length > 0) {
    throw new Error(`Missing protected production CI/CD variables: ${missing.join(", ")}`);
  }

  const releaseRoot = String(env.WORKFLOW_RELEASE_STORAGE_ROOT ?? "").trim();
  if (!path.isAbsolute(releaseRoot)) {
    throw new Error("WORKFLOW_RELEASE_STORAGE_ROOT must be an absolute path.");
  }
  return { ...env, WORKFLOW_RELEASE_STORAGE_ROOT: path.resolve(releaseRoot) };
}

export function resolveDockerSocketLocation(env = process.env) {
  return String(env.DOCKER_SOCKET_LOCATION ?? "").trim() || DEFAULT_DOCKER_SOCKET_LOCATION;
}

export async function recoverDockerServices(options = {}) {
  loadProductionEnv();
  const { serverRoot } = resolveReleasePaths();
  const env = validateRecoveryEnvironment(options.env ?? process.env);
  const recoveryEnv = {
    ...env,
    DOCKER_SOCKET_LOCATION: resolveDockerSocketLocation(env),
  };
  const releaseRoot = resolveReleaseStorageRoot({ required: true });
  await assertReleaseStorageRootWritable();
  const execute = options.runCommand ?? runCommand;
  for (const service of createDockerRecoveryServices(options.serverRoot ?? serverRoot)) {
    await recoverDockerComposeService(service, { env: recoveryEnv, runCommand: execute });
  }
  return { releaseRoot };
}

export async function recoverDockerComposeService(service, options = {}) {
  const execute = options.runCommand ?? runCommand;
  const commandOptions = { env: options.env ?? process.env, cwd: service.projectDirectory };
  await execute("docker", composeArgs(service, "config", "--quiet"), commandOptions);
  await execute("docker", composeArgs(service, "up", "--detach", "--wait", "--wait-timeout", "180"), commandOptions);
  await execute("docker", composeArgs(service, "ps"), commandOptions);
}

export function composeArgs(service, ...command) {
  return [
    "compose",
    "--project-name", service.projectName,
    "--project-directory", service.projectDirectory,
    ...service.files.flatMap((file) => ["--file", path.join(service.projectDirectory, file)]),
    ...command,
  ];
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await recoverDockerServices();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
