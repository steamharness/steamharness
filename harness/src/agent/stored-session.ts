import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry, type Conversation, type Storage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { agentRuntimeSessionKey, type RuntimePersistence } from "../runtime-storage/history";
import { SnapshotMemoryStorage } from "../runtime-storage/memory";
import type { AgentSessionSnapshot } from "../runtime-storage/contract";
import { copyAgentConversation } from "./isolate";
import { forkSessionConversation, SessionDoc } from "./session-state";
import type { AgentSessionCommand, AgentSessionReceipt } from "./session-types";

async function sessionKeys(persistence: RuntimePersistence, conversationId: string): Promise<{ key: string; sessionKey: string }[]> {
  const prefix = `agent:${encodeURIComponent(conversationId)}:`;
  return (await persistence.agentSessions(conversationId)).map(key => ({ key, sessionKey: decodeURIComponent(key.slice(prefix.length)) }));
}
async function withSession<T>(persistence: RuntimePersistence, conversationId: string, sessionKey: string,
  action: (harness: Harness, root: Conversation) => Promise<T>): Promise<T> {
  const opened = await persistence.agentStorage(conversationId, sessionKey).open();
  let harness: Harness | undefined;
  try {
    harness = await Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context);
    return await action(harness, await harness.root(context));
  } finally {
    try { if (harness) await harness.close(context); else await opened.storage.close(context); }
    finally { await opened.release?.(); }
  }
}

/** Session snapshots contain committed history and versioned state, never credentials or owners. */
export async function exportAgentSession(options: { persistence: RuntimePersistence; conversationId: string }): Promise<AgentSessionSnapshot> {
  const keys = await sessionKeys(options.persistence, options.conversationId);
  if (keys.length !== 1) throw new Error("Export requires exactly one stored agent session.");
  return options.persistence.exportSession(keys[0]!.key);
}
export async function importAgentSession(options: { persistence: RuntimePersistence; conversationId: string; sessionKey: string; snapshot: AgentSessionSnapshot }): Promise<void> {
  await options.persistence.importSession(agentRuntimeSessionKey(options.conversationId, options.sessionKey), options.snapshot);
}
export async function forkStoredAgentConversation(options: { persistence: RuntimePersistence; conversationId: string;
  command: Extract<AgentSessionCommand, { type: "fork" }> }): Promise<AgentSessionReceipt> {
  const keys = await sessionKeys(options.persistence, options.conversationId);
  if (keys.length !== 1) throw new Error("Fork requires exactly one stored agent session.");
  return withSession(options.persistence, options.conversationId, keys[0]!.sessionKey,
    (harness, root) => forkSessionConversation(harness, root, options.command));
}
export async function isolateStoredAgentConversation(options: { persistence: RuntimePersistence; sourceConversationId: string;
  conversationId: string; targetId: number; replacements?: readonly { from: string; to: string }[]; retireSource?: boolean }): Promise<void> {
  if (!Number.isSafeInteger(options.targetId) || options.targetId < 1 || options.sourceConversationId === options.conversationId) throw new Error("A distinct conversation and valid target are required.");
  const keys = await sessionKeys(options.persistence, options.sourceConversationId);
  if (keys.length !== 1) throw new Error("Isolation requires exactly one stored agent session.");
  const key = keys[0]!;
  const destinationKey = agentRuntimeSessionKey(options.conversationId, key.sessionKey);
  // A retry after a lost import response must recognize its committed origin.
  const existing = await options.persistence.agentSessions(options.conversationId);
  if (existing.length) {
    if (existing.length !== 1 || existing[0] !== destinationKey) throw new Error("The destination conversation already exists.");
    const stored = new SnapshotMemoryStorage(await options.persistence.exportSession(destinationKey));
    const origin = await stored.findDocument({ kind: "project.fork-origin", scope: { kind: "conversation", conversationId: 1 as never } }, "current", context);
    const value = origin && (await stored.document(origin.id, "current", context))?.value;
    if (value?.sourceConversationId !== options.sourceConversationId || value?.targetId !== options.targetId) throw new Error("The destination conversation already exists.");
  } else {
    const source: Storage = new SnapshotMemoryStorage(await options.persistence.exportSession(key.key));
    const destination = new SnapshotMemoryStorage();
    await copyAgentConversation(source, destination, options);
    await options.persistence.importSession(destinationKey, destination.snapshot());
  }
  if (options.retireSource) await withSession(options.persistence, options.sourceConversationId, key.sessionKey, async (harness) => {
    if (options.targetId === 1) throw new Error("An independent root cannot retire its source root.");
    const target = await harness.conversation(options.targetId as never, context);
    if (!target) throw new Error("The source conversation does not exist.");
    await target.abort(context, { background: true });
    await target.commit(async tx => { (await tx.doc(SessionDoc, target.id)).deleted = true; }, context);
  });
}
export async function cancelStoredAgentConversation(options: { persistence: RuntimePersistence; conversationId: string }): Promise<void> {
  for (const key of await sessionKeys(options.persistence, options.conversationId)) {
    await withSession(options.persistence, options.conversationId, key.sessionKey, async (harness, root) => {
      await root.abort(context, { background: true });
      let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
      do {
        const page = await harness.commit(tx => tx.scanConversations({}, 100, cursor), context);
        for (const record of page.items) if (record.id !== root.id && record.owner === undefined) await (await harness.conversation(record.id, context))?.abort(context, { background: true });
        cursor = page.next;
      } while (cursor);
      await root.waitForIdle(context);
    });
  }
}

export async function deleteStoredAgentConversation(options: { persistence: RuntimePersistence; conversationId: string }): Promise<void> {
  await cancelStoredAgentConversation(options);
  for (const key of await sessionKeys(options.persistence, options.conversationId)) await options.persistence.deleteSession(key.key);
  const lease = await options.persistence.acquire(`core:${options.conversationId}`);
  try {
    const state = (await options.persistence.list("state")).find(record => record.key === options.conversationId);
    if (state) await lease.delete(state);
  } finally { await lease.close(); }
}
