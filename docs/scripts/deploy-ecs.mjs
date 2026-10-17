import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { decodeEcsKey } from "./ecs-ssh-key.mjs";

const execFileAsync = promisify(execFile);
const HOST = "60.205.8.151";
const PORT = "22";
const FINGERPRINT = "SHA256:ErClJwyZdPzwEU05QWHex4Od9ytRxbn5iAw4Mt+GVcU";
const REMOTE_ROOT = "/srv/workflow-release";

export async function deployDocsToEcs(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const sourceDir = path.resolve(options.sourceDir ?? path.join(root, "dist", "site"));
  const commitSha = String(options.commitSha ?? process.env.CI_COMMIT_SHA ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("Docs deployment requires an exact commit SHA.");
  const remoteRoot = process.env.STEAMHARNESS_REMOTE_ROOT ?? REMOTE_ROOT;
  if (path.resolve(remoteRoot) !== REMOTE_ROOT) throw new Error(`ECS deployment root is fixed at ${REMOTE_ROOT}.`);
  const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-docs-ecs-"));
  const key = path.join(temp, "id_ed25519");
  const knownHosts = path.join(temp, "known_hosts");
  const archive = path.join(temp, `docs-${commitSha}.tgz`);
  try {
    await execFileAsync("tar", ["-czf", archive, "-C", sourceDir, "."]);
    await writeSecret(key, process.env.STEAMHARNESS_REMOTE_SSH_KEY);
    await pinHost(knownHosts);
    const ssh = ["-i", key, "-p", PORT, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, `root@${HOST}`];
    await run("ssh", [...ssh, `mkdir -p '${remoteRoot}/incoming'`]);
    await run("rsync", ["-a", "--chmod=F600", "-e", `ssh -i '${key}' -p ${PORT} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${knownHosts}'`, archive, `root@${HOST}:${remoteRoot}/incoming/`]);
    const remoteArchive = `${remoteRoot}/incoming/${path.basename(archive)}`;
    await run("ssh", [...ssh, `'${remoteRoot}/bin/ecs-runtime-agent.sh' deploy-docs '${remoteArchive}' '${commitSha}'`]);
    return { commitSha, remoteArchive };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function writeSecret(file, value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("STEAMHARNESS_REMOTE_SSH_KEY is required.");
  await writeFile(file, decodeEcsKey(existsSync(raw) ? await readFile(raw, "utf8") : raw), { mode: 0o600 });
  await chmod(file, 0o600);
}

async function pinHost(file) {
  const { stdout } = await execFileAsync("ssh-keyscan", ["-p", PORT, "-t", "ed25519", HOST]);
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
  process.stdout.write(`${JSON.stringify(await deployDocsToEcs())}\n`);
}
