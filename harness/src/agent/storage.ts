import { createHash } from "node:crypto";
import { link, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, type RegistryReader, type Storage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { HarnessError } from "../workflow/errors";

export interface AgentStorageFactory {
  /** Non-secret backend name shown in diagnostics. */
  label: string;
  /** Must acquire an exclusive owner. The Harness closes storage before release is called. */
  open(): Promise<{ storage: Storage; release?(): void | Promise<void> }>;
}

function resolveSqlitePath(file: string): string {
  // SQLite needs the Windows extended path prefix even when Node's fs accepts a long path.
  return path.toNamespacedPath(path.resolve(file));
}

/** Offline, consistent backup. Destination must be new; source must have no running owner. */
export async function exportAgentDatabase(options: { databasePath: string; destination: string }): Promise<void> {
  const source = resolveSqlitePath(options.databasePath), destination = resolveSqlitePath(options.destination);
  if (source === destination) throw new Error("The backup destination must be a new database.");
  await mkdir(path.dirname(source), { recursive: true });
  const owner = acquireOwner(source);
  let database: DatabaseSync | undefined, destinationOwner: DatabaseSync | undefined;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    database = new DatabaseSync(source, { readOnly: true });
    if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("Invalid agent database.");
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!["durable_schema", "durable_metadata", "conversations", "tasks", "documents", "entries", "submissions"].every(table => tables.has(table))) throw new Error("This is not a Pi Durable database.");
    await mkdir(path.dirname(destination), { recursive: true });
    destinationOwner = acquireOwner(destination);
    await backup(database, temporary);
    await link(temporary, destination);
  } finally {
    try { database?.close(); }
    finally {
      try { destinationOwner?.close(); }
      finally { owner.close(); await rm(temporary, { force: true }); }
    }
  }
}

/** Import an offline snapshot into a new isolated database path; never overwrite a session. */
export async function importAgentDatabase(options: { source: string; databasePath: string }): Promise<void> {
  await exportAgentDatabase({ databasePath: options.source, destination: options.databasePath });
}

function acquireOwner(file: string): DatabaseSync {
  const owner = new DatabaseSync(`${file}.owner`);
  try {
    owner.exec("PRAGMA busy_timeout = 0");
    owner.exec("BEGIN EXCLUSIVE");
    return owner;
  } catch (cause) {
    owner.close();
    throw new HarnessError({ type: "execution", message: "This agent session already has an execution owner.", metadata: { agentFailure: "owner_conflict" }, cause });
  }
}

export function agentConversationDirectory(agentStoreDir: string, conversationId: string): string {
  return path.join(agentStoreDir, createHash("sha256").update(conversationId).digest("hex"));
}

export async function openAgentStorage(databasePath: string): Promise<{ storage: Storage; release: () => void }> {
  const file = resolveSqlitePath(databasePath);
  await mkdir(path.dirname(file), { recursive: true });
  const owner = acquireOwner(file);
  try {
    return { storage: await openNodeSqliteStorage(file), release: () => owner.close() };
  } catch (error) { owner.close(); throw error; }
}

/** Join the worker first. Supply project definitions to run custom task abort handlers. */
export async function cancelAgentConversation(options: { agentStoreDir: string; conversationId: string; registry?: RegistryReader }): Promise<void> {
  const directory = agentConversationDirectory(options.agentStoreDir, options.conversationId);
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const file of files.filter(name => name.endsWith(".sqlite"))) {
    const { storage, release } = await openAgentStorage(path.join(directory, file));
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(storage, { models: createModels(), registry: options.registry ?? createRegistry() }, BACKGROUND_CONTEXT);
      const root = await harness.root(BACKGROUND_CONTEXT);
      await root.abort(BACKGROUND_CONTEXT, { background: true });
      let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
      do {
        const page = await harness.commit(tx => tx.scanConversations({}, 100, cursor), BACKGROUND_CONTEXT);
        for (const record of page.items) if (record.id !== root.id && record.owner === undefined) {
          await (await harness.conversation(record.id, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT, { background: true });
        }
        cursor = page.next;
      } while (cursor);
      await root.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      try { if (harness) await harness.close(BACKGROUND_CONTEXT); else await storage.close(BACKGROUND_CONTEXT); }
      finally { release(); }
    }
  }
}
