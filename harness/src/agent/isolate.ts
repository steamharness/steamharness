import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId, type Cursor, type DocumentCreate, type DocumentId, type EntryRecord, type JsonObject, type Storage, type StorageWrite } from "@earendil-works/pi-durable";

/** Copy committed state only; neither source nor destination starts a scheduler. */
export async function copyAgentConversation(source: Storage, destination: Storage, options: {
  sourceConversationId: string; targetId: number; replacements?: readonly { from: string; to: string }[];
}): Promise<void> {
  const origin = { sourceConversationId: options.sourceConversationId, targetId: options.targetId };
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
    await destination.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
    let nextId = entries.reduce((next, entry) => Math.max(next, entry.id + 1), 2);
    const docs = new Map<string, { id: DocumentId; sourceId: DocumentId; version: number; value: string }>();
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
          let previous = docs.get(key);
          // Identical JSON can still represent a schema-version transition or
          // a retired document's replacement. Preserve both in copied history.
          if (previous && previous.sourceId !== record.id) {
            writes.push({ type: "document.retire", id: previous.id }); docs.delete(key); previous = undefined;
          }
          if (previous?.value === serialized && previous.version === stored.version) continue;
          const content = { kind: "base" as const, version: stored.version, value };
          if (previous) writes.push({ type: "document.change", id: previous.id, content });
          else {
            const { createdAt: _createdAt, retiredAt: _retiredAt, ...definition } = record;
            const id = nextId++ as DocumentId;
            writes.push({ type: "document.create", record: { ...definition, id, scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } } as DocumentCreate, content });
            docs.set(key, { id, sourceId: record.id, version: stored.version, value: serialized });
          }
          docs.get(key)!.value = serialized;
          docs.get(key)!.version = stored.version;
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
}
