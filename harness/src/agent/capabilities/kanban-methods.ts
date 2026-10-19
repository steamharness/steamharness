import { parseKanbanMethodInvocation, type KanbanMethodInvocation } from "@steamharness/kanban-project";
import { readHostConfigurationBridgeConfig, requestHostBridge, type HostBridgeConfig } from "./host-configuration";
import type { Capability } from "./types";

export const KANBAN_METHODS_MCP_SERVER_ID = "steamharness-kanban";
export const KANBAN_METHODS_MCP_TOOL_NAME = "kanban_methods";
export const KANBAN_METHODS_MCP_TOOL_ID = `${KANBAN_METHODS_MCP_SERVER_ID}_${KANBAN_METHODS_MCP_TOOL_NAME}`;
export const KANBAN_METHODS_ENABLED_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_KANBAN_METHODS_ENABLED";
export type KanbanMethodsToolArgs = { action: "list" } | ({ action: "invoke" } & KanbanMethodInvocation);

export function readKanbanMethodsBridgeConfig(env: NodeJS.ProcessEnv = process.env): HostBridgeConfig | undefined {
  return env[KANBAN_METHODS_ENABLED_ENV] === "1" ? readHostConfigurationBridgeConfig(env) : undefined;
}

export async function runKanbanMethodsAction(
  args: KanbanMethodsToolArgs,
  config = readKanbanMethodsBridgeConfig(),
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!config) throw new Error("Kanban methods are unavailable for this run. A Desktop host with an open Kanban preview is required.");
  const { action, ...input } = args;
  if (action === "list") {
    if (Object.keys(input).length) throw new Error("Kanban method list does not accept invocation arguments.");
  } else if (action === "invoke") {
    parseKanbanMethodInvocation(input);
  } else throw new Error("Kanban method action must be list or invoke.");
  return requestHostBridge(`kanban.methods.${action}`, input, config, fetchImpl, 25_000, signal);
}

export const KANBAN_METHODS_CAPABILITY: Capability = {
  serverId: KANBAN_METHODS_MCP_SERVER_ID,
  toolName: KANBAN_METHODS_MCP_TOOL_NAME,
  toolId: KANBAN_METHODS_MCP_TOOL_ID,
  title: "Kanban page methods",
  description: "List mounted Kanban preview instances and their registered methods, then invoke a method with the exact instanceId and configurationId returned by list. Inspect location, presentation and configurationName to choose the user's intended preview. args must match the page's inputSchema; handlers validate business arguments. Calls only affect that instance. Never invent method names or automatically retry a timed out mutation; inspect state first. Open a preview first if no ready instance exists.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "invoke"] },
      instanceId: { type: "string", minLength: 1, maxLength: 200 },
      configurationId: { type: "string", maxLength: 200 },
      method: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$" },
      args: { type: "object", additionalProperties: true },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async run(context, args, signal) {
    const abortSignal = signal && context.abortSignal ? AbortSignal.any([signal, context.abortSignal]) : signal ?? context.abortSignal;
    return runKanbanMethodsAction(args as unknown as KanbanMethodsToolArgs, undefined, fetch, abortSignal);
  },
  isAvailable() { try { return readKanbanMethodsBridgeConfig() !== undefined; } catch { return false; } },
  describeFailure(error) { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? { code: error.code } : {}; },
};
