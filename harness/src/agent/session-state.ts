import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, type Conversation, type ConversationId, type EntryId, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { AgentSessionCommand, AgentSessionReceipt } from "./session-types";

export const SessionDoc = defineDoc({
  kind: "project.session", version: 1, scope: "conversation", history: "rewindable", fork: "initial",
  initial: () => ({ configurationVersion: 0, promptHash: "", promptVersion: 0,
    commands: {} as Record<string, JsonObject>, title: "", background: false as boolean, deleted: false as boolean, hostConfigurationHash: "" }),
});

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export async function sessionTarget(harness: Harness, root: Conversation, id?: number): Promise<Conversation> {
  const target = id ? await harness.conversation(id as ConversationId, context) : root;
  if (!target) throw new Error("The target conversation does not exist.");
  let record = await harness.commit(tx => tx.conversation(target.id), context);
  const seen = new Set<number>();
  while (record && record.id !== root.id && !seen.has(record.id)) {
    seen.add(record.id);
    const parent = record.owner?.conversationId ?? record.parent?.conversationId;
    record = parent ? await harness.commit(tx => tx.conversation(parent), context) : undefined;
  }
  if (record?.id !== root.id) throw new Error("The target belongs to another session.");
  return target;
}

/** The same atomic history operation for live owners and offline storage. Never starts tasks. */
export async function forkSessionConversation(harness: Harness, root: Conversation,
  command: Extract<AgentSessionCommand, { type: "fork" }>): Promise<AgentSessionReceipt> {
  if (command.type !== "fork") throw new Error("A fork command is required.");
  if (typeof command.requestId !== "string" || !command.requestId || command.requestId.length > 256 || ["__proto__", "constructor", "prototype"].includes(command.requestId)) throw new Error("A bounded stable requestId is required.");
  if (command.targetId !== undefined && (!Number.isSafeInteger(command.targetId) || command.targetId < 1)) throw new Error("A valid target conversation is required.");
  if (!Number.isSafeInteger(command.entryId) || command.entryId < 1) throw new Error("A committed entry is required for a fork.");
  const target = await sessionTarget(harness, root, command.targetId);
  const fingerprint = createHash("sha256").update(canonical({ ...command, targetId: target.id })).digest("hex");
  return target.commit(async tx => {
    const state = await tx.doc(SessionDoc, target.id);
    const previous = state.commands[command.requestId];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("The requestId was already used for another command.");
      if (previous.receipt) return JSON.parse(JSON.stringify(previous.receipt)) as AgentSessionReceipt;
    }
    if (state.deleted) throw new Error("The target conversation was deleted.");
    const fork = await tx.forkConversation(target.id, command.entryId as EntryId, { ownership: { kind: "ownerless" } });
    (await tx.doc(SessionDoc, fork.id)).title = "Fork";
    const receipt: AgentSessionReceipt = { requestId: command.requestId, status: "accepted", conversationId: target.id, forkId: fork.id };
    state.commands[command.requestId] = { fingerprint, receipt: receipt as unknown as JsonObject };
    await tx.appendEntry(target.id, { kind: "workflow.command.fork", data: { requestId: command.requestId } });
    return receipt;
  }, context);
}
