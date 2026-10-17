import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { decodePrivateKey, withRemote } from "./deploy-ecs.mjs";

const exec = promisify(execFile);
const ROOT = "/srv/workflow-release";
const SOURCE_ROOT = "/Volumes/store/steamharness-prod";
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function validateMigrationId(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{3,60}$/u.test(value ?? "")) throw new Error("STEAMHARNESS_MIGRATION_ID is required and must be a safe identifier.");
  return value;
}

export async function migrateEcs() {
  const id = validateMigrationId(process.env.STEAMHARNESS_MIGRATION_ID);
  const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-migration-"));
  try {
    return await withRemote({ root: ROOT }, async (target) => {
      const completed = await target.output(`test -f ${ROOT}/migration-audit/data-restored.json`).then(() => true, () => false);
      if (completed) return { status: "already-restored", target: "60.205.8.151:22" };
      const raw = process.env.STEAMHARNESS_MIGRATION_SSH_KEY;
      if (!raw) throw new Error("STEAMHARNESS_MIGRATION_SSH_KEY is required.");
      const contents = raw.includes("-----BEGIN") ? raw : await readFile(raw, "utf8").catch(() => raw);
      const key = path.join(temp, "source-key");
      await writeFile(key, decodePrivateKey(contents), { mode: 0o600 });
      await chmod(key, 0o600);
      const hosts = path.join(temp, "known_hosts");
      const sourceHost = process.env.STEAMHARNESS_MIGRATION_SOURCE_HOST ?? "yuhe.space";
      const sourcePort = process.env.STEAMHARNESS_MIGRATION_SOURCE_PORT ?? "7101";
      const fingerprint = process.env.STEAMHARNESS_MIGRATION_SOURCE_FINGERPRINT;
      if (!fingerprint?.startsWith("SHA256:")) throw new Error("Pin STEAMHARNESS_MIGRATION_SOURCE_FINGERPRINT before migration.");
      const scanned = await exec("ssh-keyscan", ["-p", sourcePort, "-t", "ed25519", sourceHost]);
      await writeFile(hosts, scanned.stdout);
      const checked = await exec("ssh-keygen", ["-lf", hosts, "-E", "sha256"]);
      if (!checked.stdout.includes(fingerprint)) throw new Error("Source SSH fingerprint mismatch.");
      const ssh = ["-i", key, "-p", sourcePort, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${hosts}`, `gaoruicheng@${sourceHost}`];
      const sourceScript = await readFile(new URL("../docker/ecs/export-migration.sh", import.meta.url), "utf8");
      const source = spawn("ssh", [...ssh, `bash -s -- ${quote(SOURCE_ROOT)} ${quote(id)}`], { stdio: ["pipe", "inherit", "inherit"] });
      source.stdin.end(sourceScript);
      await exited(source).catch(async (error) => {
        // The source may reset its SSH session while stopping its local services.
        // A complete preserved archive is safe to consume on the next connection.
        const preserved = await exec("ssh", [...ssh, `test -s ${quote(`${SOURCE_ROOT}/backups/${id}/migration.tgz`)}`]).then(() => true, () => false);
        if (!preserved) throw error;
      });
      const archive = path.join(temp, `${id}.tgz`);
      const download = spawn("ssh", [...ssh, `cat ${quote(`${SOURCE_ROOT}/backups/${id}/migration.tgz`)}`], { stdio: ["ignore", "pipe", "inherit"] });
      await Promise.all([exited(download), pipeline(download.stdout, createWriteStream(archive, { mode: 0o600 }))]);
      const checksum = await exec("ssh", [...ssh, `shasum -a 256 ${quote(`${SOURCE_ROOT}/backups/${id}/migration.tgz`)}`]);
      const hash = checksum.stdout.trim().split(/\s/u)[0];
      if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Missing source archive checksum.");
      await target.upload(archive, `${ROOT}/incoming/${id}.tgz`);
      await target.execute(`printf '%s  %s\\n' ${quote(hash)} ${quote(`${ROOT}/incoming/${id}.tgz`)} | sha256sum --check --status`);
      await target.remote("restore-data", [id, hash]);
      return { id, sha256: hash, status: "restored", target: "60.205.8.151:22" };
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function exited(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Migration subprocess exited ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(await migrateEcs())}\n`);
}
