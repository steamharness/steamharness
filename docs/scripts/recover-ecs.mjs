import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { decodeEcsKey } from "./ecs-ssh-key.mjs";

const execFileAsync = promisify(execFile);
const HOST = "60.205.8.151";
const FINGERPRINT = "SHA256:ErClJwyZdPzwEU05QWHex4Od9ytRxbn5iAw4Mt+GVcU";
const REMOTE_ROOT = "/srv/workflow-release";

export async function ensureEcsRelease(options = {}) {
  const remoteRoot = process.env.WORKFLOW_REMOTE_ROOT ?? "/srv/workflow-release";
  if (path.resolve(remoteRoot) !== REMOTE_ROOT) throw new Error(`ECS deployment root is fixed at ${REMOTE_ROOT}.`);
  const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-docs-recovery-"));
  const key = path.join(temp, "id_ed25519");
  const knownHosts = path.join(temp, "known_hosts");
  try {
    await writeSecret(key, process.env.WORKFLOW_REMOTE_SSH_KEY);
    await pinHost(knownHosts);
    const ssh = ["-i", key, "-p", "22", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, `root@${HOST}`];
    await run("ssh", [...ssh, `'${remoteRoot}/bin/ecs-runtime-agent.sh' ensure release`]);
    return { target: "release", remoteRoot };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function writeSecret(file, value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("WORKFLOW_REMOTE_SSH_KEY is required.");
  await writeFile(file, decodeEcsKey(existsSync(raw) ? await readFile(raw, "utf8") : raw), { mode: 0o600 });
  await chmod(file, 0o600);
}

async function pinHost(file) {
  const { stdout } = await execFileAsync("ssh-keyscan", ["-p", "22", "-t", "ed25519", HOST]);
  await writeFile(file, stdout, "utf8");
  const { stdout: fingerprint } = await execFileAsync("sh", ["-c", `ssh-keygen -lf '${file}' -E sha256`]);
  if (!fingerprint.includes(FINGERPRINT)) throw new Error("ECS SSH host fingerprint does not match the pinned value.");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(await ensureEcsRelease())}\n`);
}
