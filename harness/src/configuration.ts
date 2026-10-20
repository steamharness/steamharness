import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyConfigurationAction, configurationSnapshot, exportConfigurations, parseConfigurationDefinition, readConfigurationState,
  PROJECT_CONFIGURATION_FILE, ProjectConfigurationError, validateConfigurationAction, isConfigurationValue,
  type ConfigurationValue, type ConfigurationValues, type ProjectConfigurationAction, type ProjectConfigurationSnapshot, type ProjectConfigurationState,
} from "@steamharness/project-configuration";
export * from "@steamharness/project-configuration";

const scope = new AsyncLocalStorage<ProjectConfigurationSnapshot>();
export function getConfig<T extends ConfigurationValue = ConfigurationValue>(key: string): T | undefined { return scope.getStore()?.values[key] as T | undefined; }
export function getProjectConfiguration(): ProjectConfigurationSnapshot | undefined { return scope.getStore(); }
export function withProjectConfiguration<T>(snapshot: ProjectConfigurationSnapshot, run: () => T): T {
  const value = structuredClone(snapshot);
  const freeze = (item: unknown): void => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(value); return scope.run(value, run);
}
export function currentConfigurationValues(): ConfigurationValues { return scope.getStore()?.values ?? {}; }

/** Shared by Studio, CLI Web, CLI and direct local SDK execution. Values never enter project source. */
export async function createLocalProjectConfigurationStore(projectDir: string, options: { rootDir?: string; storageKey?: string } = {}) {
  const directory = await realpath(projectDir);
  const root = options.rootDir ?? path.join(os.homedir(), ".steamharness", "configurations");
  const key = createHash("sha256").update(options.storageKey ?? directory).digest("hex");
  const filename = path.join(root, `${key}.json`), lock = `${filename}.lock.sqlite`;
  const declared = async () => {
    try { return parseConfigurationDefinition(JSON.parse(await readFile(path.join(directory, PROJECT_CONFIGURATION_FILE), "utf8"))).fields; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const load = async (): Promise<ProjectConfigurationState> => {
    let stored: unknown;
    try { stored = JSON.parse(await readFile(filename, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const state = readConfigurationState(stored, await declared(), () => `default-${key.slice(0, 24)}`);
    if (!stored || JSON.stringify((stored as ProjectConfigurationState).fields) !== JSON.stringify(state.fields)) {
      if (stored) state.revision++;
      await atomic(filename, state);
    }
    return state;
  };
  const atomic = async (target: string, value: unknown) => {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  };
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // SQLite releases this cross-process guard on crash; stale PID-file recovery cannot remove a new owner's lock.
    const guard = new DatabaseSync(lock);
    const started = Date.now();
    try {
      guard.exec("PRAGMA busy_timeout = 0");
      while (true) {
        try { guard.exec("BEGIN IMMEDIATE"); break; }
        catch (error) {
          if (![5, 6].includes((error as { errcode: number }).errcode)) throw error;
          if (Date.now() - started > 10_000) throw new ProjectConfigurationError("Configuration is busy. Try again.", "CONFIGURATION_BUSY");
          await delay(25);
        }
      }
      try { return await run(); } finally { guard.exec("ROLLBACK"); }
    } finally { guard.close(); }
  };
  const read = () => exclusive(load);
  return {
    read,
    async dispatch(call: ProjectConfigurationAction) {
      validateConfigurationAction(call);
      if (call.action === "get") return read();
      if (call.action === "export") return exportConfigurations(await read(), call.id);
      return exclusive(async () => {
        const next = applyConfigurationAction(await load(), call, randomUUID);
        await atomic(filename, next); return next;
      });
    },
    async snapshot(options: { id?: string; runId?: string; required?: boolean } = {}): Promise<ProjectConfigurationSnapshot> {
      const runFile = options.runId ? path.join(root, "snapshots", key, `${createHash("sha256").update(options.runId).digest("hex")}.json`) : undefined;
      if (runFile) return exclusive(async () => {
        try { return parseSnapshot(JSON.parse(await readFile(runFile, "utf8"))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const snapshot = configurationSnapshot(await load(), options.id, options.required !== false);
        await atomic(runFile, snapshot);
        return snapshot;
      });
      return configurationSnapshot(await read(), options.id, options.required !== false);
    },
  };
}

function parseSnapshot(value: unknown): ProjectConfigurationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectConfigurationError("Invalid run configuration snapshot.");
  const snapshot = value as ProjectConfigurationSnapshot;
  if (typeof snapshot.id !== "string" || typeof snapshot.name !== "string" || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !isConfigurationValue(snapshot.values) || !snapshot.values || typeof snapshot.values !== "object" || Array.isArray(snapshot.values)) throw new ProjectConfigurationError("Invalid run configuration snapshot.");
  return snapshot;
}
