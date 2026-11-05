import { AsyncLocalStorage } from "node:async_hooks";
import type { NodeContext } from "../types/index";
import type { AgentInput } from "./types";
import type { AgentSessionSnapshot } from "./session-types";

export interface BotNodeLifecycle {
  prepare(input: AgentInput, context: NodeContext): Promise<AgentInput>;
  completed(snapshot: AgentSessionSnapshot, input: AgentInput, context: NodeContext): Promise<void>;
}
const nodes = new WeakMap<object, BotNodeLifecycle>();
interface BotRequestScope { requestId: string; projectId?: string; entryId?: string }
const requests = new AsyncLocalStorage<BotRequestScope>();
export function registerBotNode(node: object, lifecycle?: BotNodeLifecycle): void { if (lifecycle) nodes.set(node, lifecycle); }
export function botNodeLifecycle(node: object): BotNodeLifecycle | undefined { return nodes.get(node); }
export function currentBotRequestScope(): BotRequestScope | undefined { return requests.getStore(); }
export function currentBotRequestId(projectId?: string, entryId?: string): string | undefined {
  const scope = requests.getStore();
  if (projectId !== undefined && (scope?.projectId !== projectId || scope.entryId !== entryId)) return;
  return scope?.requestId;
}
export function withBotRequest<T>(requestId: string, run: () => T, owner?: { projectId?: string; entryId?: string }): T {
  const source = owner ?? requests.getStore();
  return requests.run({ requestId, projectId: source?.projectId, entryId: source?.entryId }, run);
}
