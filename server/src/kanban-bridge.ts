import type { Storage } from "./storage";
import { HttpError } from "./protocol";
import { parseKanbanBridgeCall, type KanbanBridgeCall } from "@steamharness/kanban-project";
import type { RuntimeLocale } from "steamharness";
import type { AccessActor } from "@steamharness/project-access";
export function readKanbanBridgeCall(value: unknown): KanbanBridgeCall {
  try { return parseKanbanBridgeCall(value); } catch { throw new HttpError(400,400,"The Kanban bridge request is invalid."); }
}
export async function invokeServerKanbanBridge(storage: Storage, projectId: string, call: KanbanBridgeCall, options: { entryId: string; actor: AccessActor; target?: string; runtimeLocale?: RuntimeLocale }): Promise<unknown> {
  const { operation, input } = readKanbanBridgeCall(call);
  if (operation === "runtime.getLocale") return options.runtimeLocale ?? "en";
  if (operation.startsWith('entries.') || operation.startsWith('conversations.')) throw new HttpError(409, 409, 'Open this project in CLI Web or Studio to execute Workflow operations and connect conversations.', { code: 'ENTRY_RUNTIME_UNAVAILABLE' });
  throw new HttpError(400, 400, 'Unsupported Kanban resource operation.');
}
