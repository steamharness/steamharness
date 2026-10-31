import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry, ROOT_CONVERSATION_ID, type ConversationId, type Cursor, type DocumentCreate, type DocumentId,
  type EntryRecord, type JsonObject, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { agentConversationDirectory, openAgentStorage } from "./storage";
import { SessionDoc } from "./session-state";

/** Copy one transcript into a new root, without importing tasks, submissions or execution ownership. */
export async function isolateAgentConversation(options: { agentStoreDir: string; sourceConversationId: string;
  conversationId: string; targetId: number; replacements?: readonly { from: string; to: string }[]; retireSource?: boolean }): Promise<void> {
  if (!Number.isSafeInteger(options.targetId) || options.targetId < 1 || !options.conversationId || !options.sourceConversationId
    || options.conversationId === options.sourceConversationId) throw new Error("A distinct conversation and valid target are required.");
  const sourceDir = agentConversationDirectory(options.agentStoreDir, options.sourceConversationId);
  const destinationDir = agentConversationDirectory(options.agentStoreDir, options.conversationId);
  const files = (await readdir(sourceDir)).filter(name => name.endsWith(".sqlite"));
  if (files.length !== 1) throw new Error("Isolation requires exactly one stored agent session.");
  await mkdir(destinationDir, { recursive: true });
  const owner = new DatabaseSync(`${destinationDir}.owner`);
  const snapshot = path.join(destinationDir, `${randomUUID()}.snapshot`), temporary = path.join(destinationDir, `${randomUUID()}.tmp`);
  let source: Storage | undefined, destination: Storage | undefined;
  let completed = false;
  const origin = { sourceConversationId: options.sourceConversationId, targetId: options.targetId };
  try {
    owner.exec("BEGIN EXCLUSIVE");
    const existing = (await readdir(destinationDir)).filter(name => name.endsWith(".sqlite"));
    if (existing.length) {
      destination = await openNodeSqliteStorage(path.join(destinationDir, existing[0]!));
      const record = await destination.findDocument({ kind: "project.fork-origin", scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } }, "current", context);
      const value = record && (await destination.document(record.id, "current", context))?.value;
      if (existing.length !== 1 || value?.sourceConversationId !== origin.sourceConversationId || value?.targetId !== origin.targetId) throw new Error("The destination conversation already exists.");
      completed = true; return;
    }
    // SQLite backup gives a consistent read of a live owner's committed state.
    // Never open a second Harness or execute recovery against the source.
    const database = new DatabaseSync(path.join(sourceDir, files[0]!), { readOnly: true });
    try { await backup(database, snapshot); } finally { database.close(); }
    source = await openNodeSqliteStorage(snapshot);
    const targetId = options.targetId as ConversationId;
    if (!await source.conversation(targetId, context)) throw new Error("The source conversation does not exist.");
    const session = await source.findDocument({ kind: "project.session", scope: { kind: "conversation", conversationId: targetId } }, "current", context);
    if (session && (await source.document(session.id, "current", context))?.value.deleted) throw new Error("The source conversation was deleted.");
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await source.scanEntries({ conversationId: targetId, order: "ascending" }, 256, cursor, context);
      entries.push(...page.items); cursor = page.next;
    } while (cursor);
    destination = await openNodeSqliteStorage(temporary);
    await destination.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
    let nextId = Math.max(1, ...entries.map(entry => entry.id)) + 1;
    const docs = new Map<string, { id: DocumentId; value: string }>();
    const replacements = [...options.replacements ?? []].filter(item => item.from && item.from !== item.to).sort((a, b) => b.from.length - a.from.length);
    const rewrite = (value: unknown): unknown => typeof value === "string" ? replacements.reduce((text, item) => text.split(item.from).join(item.to), value)
      : Array.isArray(value) ? value.map(rewrite) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)])) : value;
    const copyDocuments = async (conversationId: ConversationId, at: Parameters<Storage["scanDocuments"]>[0]["at"], historical: boolean): Promise<StorageWrite[]> => {
      const writes: StorageWrite[] = [], seen = new Set<string>();
      let pageCursor: Cursor | undefined;
      do {
        const page = await source!.scanDocuments({ scope: { kind: "conversation", conversationId }, at }, 256, pageCursor, context);
        for (const record of page.items) {
          if (record.scope.kind !== "conversation" || record.fork === "initial" || historical && record.fork !== "asOf") continue;
          const stored = await source!.document(record.id, at, context);
          if (!stored) throw new Error("A source document could not be read.");
          const key = JSON.stringify([record.kind, record.key ?? null]), value = rewrite(stored.value) as JsonObject, serialized = JSON.stringify(value);
          seen.add(key);
          const previous = docs.get(key);
          if (previous?.value === serialized) continue;
          const content = { kind: "base" as const, version: stored.version, value };
          if (previous) writes.push({ type: "document.change", id: previous.id, content });
          else {
            const { createdAt: _createdAt, retiredAt: _retiredAt, ...definition } = record;
            const id = nextId++ as DocumentId;
            writes.push({ type: "document.create", record: { ...definition, id, scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } } as DocumentCreate, content });
            docs.set(key, { id, value: serialized });
          }
          docs.get(key)!.value = serialized;
        }
        pageCursor = page.next;
      } while (pageCursor);
      for (const [key, previous] of docs) if (!seen.has(key) && (historical || key !== JSON.stringify(["project.fork-origin", null]))) {
        writes.push({ type: "document.retire", id: previous.id }); docs.delete(key);
      }
      return writes;
    };
    // Keep historical document checkpoints as well, so branching again at an
    // older imported entry observes that entry's plan and custom asOf state.
    for (let index = 0; index < entries.length;) {
      const selected = (await source.entry(entries[index]!.id, context))!;
      const writes = await copyDocuments(selected.entry.conversationId, selected.commitSeq, true);
      do {
        const entry = entries[index]!, { byTaskId: _byTaskId, ...value } = entry;
        writes.push({ type: "entry", value: { ...rewrite(value) as EntryRecord, conversationId: ROOT_CONVERSATION_ID } });
        index++;
      } while (index < entries.length && (await source.entry(entries[index]!.id, context))?.commitSeq === selected.commitSeq);
      await destination.commit(writes, context);
    }
    const writes = await copyDocuments(targetId, "current", false);
    writes.push({ type: "document.create", record: { id: nextId++ as DocumentId, kind: "project.fork-origin", scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID }, history: "latest", fork: "initial" },
      content: { kind: "base", version: 1, value: origin } });
    await destination.commit(writes, context);
    await destination.close(context); destination = undefined;
    await link(temporary, path.join(destinationDir, files[0]!));
    completed = true;
  } finally {
    try { await source?.close(context); }
    finally { try { await destination?.close(context); } finally { owner.close(); await Promise.all([snapshot, temporary].flatMap(file => [file, `${file}-wal`, `${file}-shm`]).map(file => rm(file, { force: true }))); } }
    if (completed && options.retireSource) {
      const opened = await openAgentStorage(path.join(sourceDir, files[0]!));
      let harness: Harness | undefined;
      try {
        harness = await Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context);
        if (options.targetId === ROOT_CONVERSATION_ID) throw new Error("An independent root cannot retire its source root.");
        const target = await harness.conversation(options.targetId as ConversationId, context);
        if (!target) throw new Error("The source conversation does not exist.");
        await target.abort(context, { background: true });
        await target.commit(async tx => { (await tx.doc(SessionDoc, target.id)).deleted = true; }, context);
      } finally { try { if (harness) await harness.close(context); else await opened.storage.close(context); } finally { opened.release(); } }
    }
  }
}
