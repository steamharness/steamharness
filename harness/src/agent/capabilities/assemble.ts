import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { NodeContext } from "../../types/context";
import { createMcpToolServer } from "../mcp/server";
import { loadTypebox } from "../pi";
import { GLOBAL_MEMORY_CAPABILITY } from "./global-memory";
import { HOST_CONFIGURATION_CAPABILITY } from "./host-configuration";
import { KANBAN_METHODS_CAPABILITY } from "./kanban-methods";
import { KNOWLEDGE_CAPABILITY } from "./knowledge";
import { KV_CAPABILITY } from "./kv";
import { PRESENTATION_CARD_CAPABILITY } from "./presentation-card";
import type { Capability } from "./types";

/**
 * Every workflow capability, in the order a host's tool panel lists them.
 *
 * The catalogue, not the offer: a capability the environment cannot serve is
 * still described here, and `isProjectCapabilityAvailable` is what a caller
 * asks before putting one in front of a model.
 */
export const STEAMHARNESS_CAPABILITIES: readonly Capability[] = [
  KNOWLEDGE_CAPABILITY,
  KV_CAPABILITY,
  GLOBAL_MEMORY_CAPABILITY,
  HOST_CONFIGURATION_CAPABILITY,
  KANBAN_METHODS_CAPABILITY,
  PRESENTATION_CARD_CAPABILITY,
];

export interface CapabilityContext {
  context: NodeContext;
  /**
   * Consulted before a call runs. Throwing blocks it; throwing
   * `user_input_required` parks the run instead.
   */
  approve?: (toolId: string, args: unknown) => Promise<void>;
  /**
   * Whether durable memory is part of this run.
   *
   * A host that offers no memory store leaves it out entirely, so the model
   * is never shown a tool whose every call would fail.
   */
  globalMemory?: boolean;
}

export function listProjectCapabilityToolIds(options: { globalMemory?: boolean } = {}): string[] {
  return selectCapabilities(options).map((capability) => capability.toolId);
}

export function findProjectCapability(toolId: string): Capability | undefined {
  return STEAMHARNESS_CAPABILITIES.find((capability) => capability.toolId === toolId);
}

/**
 * Whether a capability can serve in this process right now.
 *
 * A host that hosts capabilities over MCP has to decide which servers to
 * stand up before a client ever asks, and the answer for host configuration
 * depends on the environment rather than on the project.
 */
export function isProjectCapabilityAvailable(toolId: string): boolean {
  return requireProjectCapability(toolId).isAvailable?.() !== false;
}

function requireProjectCapability(toolId: string): Capability {
  const capability = findProjectCapability(toolId);
  if (capability === undefined) {
    throw new Error(`Unknown workflow capability tool "${toolId}".`);
  }
  return capability;
}

/**
 * Renders the capabilities as agent tools.
 *
 * These tools are not filtered by `permissionPolicy` — that policy governs
 * the built-in coding tools — so the host's own catalogue is what decides
 * which of them exist and which need approving.
 */
export async function createProjectCapabilityTools(
  options: CapabilityContext,
): Promise<AgentTool[]> {
  const Type = await loadTypebox();

  return selectCapabilities(options).map((capability): AgentTool => ({
    name: capability.toolId,
    label: capability.title,
    description: capability.description,
    parameters: Type.Unsafe(capability.inputSchema),
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      await options.approve?.(capability.toolId, params);
      return {
        content: [{ type: "text" as const, text: stringify(await capability.run(
          options.context,
          (params ?? {}) as Record<string, unknown>,
          signal,
        )) }],
        details: {},
      };
    },
  }) as unknown as AgentTool);
}

/**
 * Hosts one capability as an MCP server.
 *
 * The schema published here is the same one the agent tool is built from, so
 * a project that reaches these capabilities over MCP and one that calls them
 * directly describe them identically to their model.
 */
export async function createProjectCapabilityServer(
  toolId: string,
  options: Pick<CapabilityContext, "context" | "approve">,
): Promise<Server> {
  const capability = requireProjectCapability(toolId);

  return createMcpToolServer({
    name: capability.serverId,
    tools: [{
      name: capability.toolName,
      title: capability.title,
      description: capability.description,
      inputSchema: capability.inputSchema,
      async call(args, signal) {
        try {
          await options.approve?.(capability.toolId, args);
          return { text: stringify(await capability.run(options.context, args, signal)) };
        } catch (error) {
          return { text: stringify(failureEnvelope(capability, args, error)), isError: true };
        }
      },
    }],
  });
}

/**
 * Runs one action of a capability by tool id.
 *
 * The resume path needs this: a paused approval is answered after the turn
 * that raised it is gone, so the call has to be re-addressable by the id the
 * host approved rather than by the closure that built it.
 */
export async function runProjectCapabilityAction(
  toolId: string,
  context: NodeContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  return requireProjectCapability(toolId).run(context, args);
}

function selectCapabilities(options: { globalMemory?: boolean }): Capability[] {
  return STEAMHARNESS_CAPABILITIES.filter(
    (capability) => capability !== GLOBAL_MEMORY_CAPABILITY || options.globalMemory === true,
  ).filter((capability) => capability.isAvailable?.() !== false);
}

function failureEnvelope(
  capability: Capability,
  args: Record<string, unknown>,
  error: unknown,
): Record<string, unknown> {
  return {
    action: typeof args.action === "string" ? args.action : undefined,
    errCode: 1,
    errMessage: error instanceof Error ? error.message : String(error),
    ...(capability.describeFailure?.(error) ?? {}),
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}
