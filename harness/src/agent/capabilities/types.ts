import type { NodeContext } from "../../types/context";

/**
 * A workflow capability, described once and rendered twice.
 *
 * The description is the contract. Its `inputSchema` is a plain JSON Schema,
 * which is exactly what an MCP client is handed and what the agent SDK is
 * handed too (wrapped, unchanged) — so the two renderings cannot drift, and
 * neither side needs a translation layer in the middle.
 */
export interface Capability {
  /** MCP server id, and the prefix of the tool id. */
  serverId: string;
  toolName: string;
  /** `<serverId>_<toolName>`: the id a host grants permissions by. */
  toolId: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Runs one action. Throwing is how a call fails; the caller turns that into
   * the envelope its own client expects.
   */
  run(context: NodeContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /**
   * Whether this capability can serve in this process at all.
   *
   * A host either brought what a capability needs or it did not, and a tool
   * whose every call would fail is worse than no tool — so a host asks this
   * before exposing one. Defaults to available.
   */
  isAvailable?(): boolean;
  /** Extra fields folded into the failure envelope, e.g. a host error code. */
  describeFailure?(error: unknown): Record<string, unknown>;
}
