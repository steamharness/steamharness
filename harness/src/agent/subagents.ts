import { defineDoc, defineDocFamily, type JsonObject, type RegistrySnapshot, type Task, type TaskId, type TaskOptions, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentWorkInput } from "./session-types";
import { withCancel } from "@earendil-works/chord/context";

/** Release losing subscriptions before the next admission attempt. */
export async function waitForAgentWorkChange(ids: readonly TaskId[], wait: (id: TaskId, context: Context) => Promise<unknown>, context: Context): Promise<void> {
  const child = withCancel(context);
  try { await Promise.race(ids.map(id => wait(id, child.context))); }
  finally { child.cancel(); }
}

export const AgentDefinitionsDoc = defineDoc({ kind: "project.agent-definitions", version: 1, scope: "conversation",
  history: "latest", fork: "initial", initial: () => ({ definitions: {} as Record<string, JsonObject> }) });
export const AgentRoleDoc = defineDoc({ kind: "project.agent-role", version: 1, scope: "conversation",
  history: "rewindable", fork: "initial", initial: () => ({ definition: null as JsonObject | null, workId: "", attempt: 0,
    metadata: {} as JsonObject }) });
// Task-scoped documents retire at settlement. Keep progress under the parent
// conversation, keyed by task ID, so completed/failed work remains inspectable.
export const AgentWorkProgressDoc = defineDocFamily({ kind: "project.agent-work-progress", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  initial: () => ({ completed: 0, total: 0, phase: "", error: "", data: null as JsonValue }) });
/** True only while a new host interrupts the previous execution tree before accepting input. */
export const AgentSessionLifecycleDoc = defineDoc({ kind: "project.agent-lifecycle", version: 1, scope: "conversation",
  history: "latest", fork: "initial", initial: () => ({ interrupted: false as boolean }) });

export type DelegationInput = {
  prompt: string; background: boolean; model: { provider: string; modelId: string } | null; sourceId: string;
  workId?: string; agentId?: string; definition?: JsonObject; label?: string; metadata?: Record<string, JsonValue>;
  reportToParent?: boolean; attempt?: number; retryOf?: number; retryChildId?: number;
};
export type DelegationState = { phase: "create" } | { phase: "wait"; childId: number }
  | { phase: "report"; childId: number; answer: string; failed?: boolean };

/** Identify the authorized role/work owning a native tool, without inspecting internal task inputs. */
export async function readAgentWorkContext(api: ToolExecutionApi, context: Context) {
  return api.commit(async tx => {
    const conversation = await tx.conversation(api.conversationId);
    if (!conversation?.owner) throw new Error("This tool requires an owned agent work item.");
    const role = await tx.doc(AgentRoleDoc, api.conversationId);
    if (!role.definition || !role.workId) throw new Error("The conversation has no named agent role.");
    return { agentId: String(role.definition.id), workId: role.workId, attempt: role.attempt,
      taskId: conversation.owner.taskId, parentConversationId: conversation.owner.conversationId, metadata: JSON.parse(JSON.stringify(role.metadata)) as JsonObject };
  }, context);
}

/** Atomically enqueue a batch. All table reads precede the first table write. */
export async function enqueueAgentWorks(tx: Tx, registry: RegistrySnapshot, inputs: readonly AgentWorkInput[],
  options: TaskOptions): Promise<TaskId<string>[]> {
  if (!inputs.length || inputs.length > 1000) throw new Error("Provide 1-1000 agent work items.");
  for (const input of inputs) if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/.test(input.workId) || !input.prompt?.trim() || input.prompt.length > 100_000) {
    throw new Error("Agent work requires a bounded stable workId and a non-empty prompt.");
  }
  const conversationId = options.conversationId;
  if (!conversationId) throw new Error("Agent work must name its parent conversation.");
  const parent = await tx.conversation(conversationId);
  if (!parent || parent.owner) throw new Error("Subagents cannot delegate again.");
  const definitions = await tx.doc(AgentDefinitionsDoc, conversationId);
  const task = registry.task("project.delegation") as Task<DelegationInput, DelegationState, string, object> | undefined;
  if (!task) throw new Error("Agent delegation is not enabled.");
  let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
  const matches = new Map<string, { id: TaskId; input: DelegationInput }>();
  do {
    const page = await tx.scanTasks({ conversationId, kind: "project.delegation" }, 100, cursor);
    for (const record of page.items) {
      const input = record.input as DelegationInput;
      if (input.workId && (!matches.has(input.workId) || matches.get(input.workId)!.id < record.id)) matches.set(input.workId, { id: record.id, input });
    }
    cursor = page.next;
  } while (cursor);
  const ids: TaskId<string>[] = [];
  for (const input of inputs) {
    const definition = definitions.definitions[input.agentId];
    if (!definition) throw new Error(`Unknown or unavailable agent role: ${input.agentId}`);
    const existing = matches.get(input.workId);
    if (existing) {
      if (existing.input.agentId !== input.agentId || existing.input.prompt !== input.prompt) throw new Error("The workId was already used for different agent work.");
      ids.push(existing.id as TaskId<string>); continue;
    }
    const stored: DelegationInput = { prompt: input.prompt, background: options.background === true, model: null,
      sourceId: input.workId, workId: input.workId, agentId: input.agentId, definition: JSON.parse(JSON.stringify(definition)),
      attempt: 1, label: input.label, metadata: input.metadata, reportToParent: input.reportToParent ?? false };
    const id = await tx.createTask(task, JSON.parse(JSON.stringify(stored)) as DelegationInput, options);
    matches.set(input.workId, { id, input: stored }); ids.push(id);
  }
  return ids;
}

/** Enqueue from a native tool or registered durable task, inside its atomic commit. */
export async function enqueueAgentWork(tx: Tx, registry: RegistrySnapshot, input: AgentWorkInput,
  options: TaskOptions): Promise<TaskId<string>> {
  return (await enqueueAgentWorks(tx, registry, [input], options))[0]!;
}
