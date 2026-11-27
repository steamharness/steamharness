import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeAuthServer } from "@steamharness/server-auth";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  createEmptyProjectAuthConfig, normalizeProjectAuthConfig, resolveProjectCliAuthDir,
  type AuthConfig,
} from "@steamharness/auth-config";

function sameServer(left: string, right: string): boolean {
  try { return normalizeAuthServer(left) === normalizeAuthServer(right); } catch { return false; }
}
export type AuthPurpose = 'project' | 'ai';
export function cliAuthIsUsable(config: AuthConfig): boolean {
  return !!config.serverUrl && !!config.apiKey && (!config.expiresAt || Date.parse(config.expiresAt) > Date.now());
}

function scopedFilePath(env: NodeJS.ProcessEnv, serverUrl?: string, purpose: AuthPurpose = 'project'): string {
  const server = serverUrl ? `-${createHash("sha256").update(normalizeAuthServer(serverUrl)).digest("hex").slice(0, 20)}` : "";
  return path.join(resolveProjectCliAuthDir(env), `${purpose}${server}.json`);
}

/** Read the active channel identity, or the identity saved for a particular Server. */
export async function readCliAuthConfig(env: NodeJS.ProcessEnv = process.env, serverUrl?: string, purpose: AuthPurpose = 'project'): Promise<AuthConfig> {
  const read = async (file: string) => {
    try { return normalizeProjectAuthConfig(JSON.parse(await readFile(file, "utf8"))); } catch { return undefined; }
  };
  const config = await read(scopedFilePath(env, undefined, purpose)) ?? createEmptyProjectAuthConfig();
  if (!serverUrl || sameServer(config.serverUrl, serverUrl)) return config;
  const saved = await read(scopedFilePath(env, serverUrl, purpose));
  return saved && sameServer(saved.serverUrl, serverUrl) ? saved : createEmptyProjectAuthConfig();
}
export function readCliAuthConfigSync(env: NodeJS.ProcessEnv = process.env, serverUrl?: string, purpose: AuthPurpose = 'project'): AuthConfig {
  const read = (file: string) => {
    try { return normalizeProjectAuthConfig(JSON.parse(readFileSync(file, "utf8"))); } catch { return undefined; }
  };
  const config = read(scopedFilePath(env, undefined, purpose)) ?? createEmptyProjectAuthConfig();
  if (!serverUrl || sameServer(config.serverUrl, serverUrl)) return config;
  const saved = read(scopedFilePath(env, serverUrl, purpose));
  return saved && sameServer(saved.serverUrl, serverUrl) ? saved : createEmptyProjectAuthConfig();
}

const writes = new Map<string, Promise<void>>();
function serialize(file: string, run: () => Promise<void>): Promise<void> {
  const next = (writes.get(file) ?? Promise.resolve()).catch(() => undefined).then(run);
  writes.set(file, next);
  void next.finally(() => { if (writes.get(file) === next) writes.delete(file); }).catch(() => undefined);
  return next;
}
async function atomicWrite(file: string, config: AuthConfig): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
export function writeCliAuthConfig(config: AuthConfig, env: NodeJS.ProcessEnv = process.env, purpose: AuthPurpose = 'project'): Promise<void> {
  const snapshot = { ...env }, file = scopedFilePath(snapshot, undefined, purpose), value = normalizeProjectAuthConfig(config);
  return serialize(file, async () => {
    if (value.serverUrl && value.apiKey) await atomicWrite(scopedFilePath(snapshot, value.serverUrl, purpose), value);
    await atomicWrite(file, value);
  });
}
export function clearCliAuthConfig(env: NodeJS.ProcessEnv = process.env, expectedApiKey?: string, purpose: AuthPurpose = 'project', serverUrl?: string): Promise<void> {
  const snapshot = { ...env }, file = scopedFilePath(snapshot, undefined, purpose);
  return serialize(file, async () => {
    const current = await readCliAuthConfig(snapshot, undefined, purpose);
    if (serverUrl && !sameServer(current.serverUrl, serverUrl)) {
      const selected = await readCliAuthConfig(snapshot, serverUrl, purpose);
      if (expectedApiKey === undefined || selected.apiKey === expectedApiKey) await rm(scopedFilePath(snapshot, serverUrl, purpose), { force: true });
      return;
    }
    if (expectedApiKey !== undefined && current.apiKey !== expectedApiKey) return;
    if (current.serverUrl) await rm(scopedFilePath(snapshot, current.serverUrl, purpose), { force: true });
    // Keep a channel marker so signing out cannot restore an old legacy credential.
    await atomicWrite(file, createEmptyProjectAuthConfig());
  });
}
