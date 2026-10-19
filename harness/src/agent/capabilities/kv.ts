import { CONVERSATION_STATE_KEY } from "../../conversation/index";
import { TOKEN_USAGE_ENTRY_KEY_PREFIX, TOKEN_USAGE_TOTAL_KEY } from "../../token-usage/index";
import { HarnessError } from "../../workflow/errors";
import type { NodeContext } from "../../types/context";
import { selectWorkflowStorage } from "./storage";
import type { Capability } from "./types";

export const KV_MCP_SERVER_ID = "workflow-kv";
export const KV_MCP_TOOL_NAME = "kv_store";
export const KV_MCP_TOOL_ID = `${KV_MCP_SERVER_ID}_${KV_MCP_TOOL_NAME}`;

type KvAction = "get" | "set";
type KvScope = "project" | "conversation";

interface KvToolArgs {
  action: KvAction;
  scope: KvScope;
  key: string;
  value?: unknown;
}

/** Declared by the schema, and checked here because nothing else checks it. */
const MAX_KEY_LENGTH = 500;

/**
 * Keys the runtime keeps in the namespaces this tool can write to.
 *
 * The tool is driven by a model — which a file in the workspace can talk to —
 * so "write any key" is also "overwrite the token accounting or the pending
 * plan approval". Both namespaces are shared with Core's own bookkeeping, and
 * the conversation state object holds every other value at once.
 */
const RESERVED_KEYS_BY_SCOPE: Readonly<Record<KvScope, ReadonlySet<string>>> = {
  project: new Set([TOKEN_USAGE_TOTAL_KEY]),
  conversation: new Set([CONVERSATION_STATE_KEY, TOKEN_USAGE_TOTAL_KEY]),
};
const RESERVED_KEY_PREFIXES_BY_SCOPE: Readonly<Record<KvScope, readonly string[]>> = {
  project: [TOKEN_USAGE_ENTRY_KEY_PREFIX],
  conversation: [TOKEN_USAGE_ENTRY_KEY_PREFIX, "agent."],
};

export async function runKvAction(
  context: Pick<NodeContext, "storage">,
  args: KvToolArgs,
): Promise<unknown> {
  // Nothing validates the arguments on the way in — an MCP client publishes
  // the schema but is not obliged to honour it — so the shape is checked here.
  if (args.action !== "get" && args.action !== "set") {
    throw new HarnessError({
      type: "input_validation",
      message: `kv_store action is invalid: ${String(args.action)}.`,
      nodeName: KV_MCP_TOOL_ID,
    });
  }
  if (args.scope !== "project" && args.scope !== "conversation") {
    throw new HarnessError({
      type: "input_validation",
      message: `kv_store scope is invalid: ${String(args.scope)}.`,
      nodeName: KV_MCP_TOOL_ID,
    });
  }

  const storage = selectWorkflowStorage(context);
  const namespace = args.scope === "project" ? storage.kv : storage.kv.conversation;
  const key = readKey(args.key);
  assertKeyWritable(args.scope, key);

  if (args.action === "get") {
    const value = await namespace.getValue(key);
    return {
      action: "get" as const,
      scope: args.scope,
      key,
      found: value !== undefined,
      ...(value === undefined ? {} : { value }),
    };
  }

  if (args.value === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: 'kv_store action "set" requires value.',
      nodeName: KV_MCP_TOOL_ID,
      metadata: { action: args.action, scope: args.scope, key },
    });
  }
  assertJsonSerializable(args.value);
  await namespace.setValue(key, args.value);
  return { action: "set" as const, scope: args.scope, key, stored: true };
}

function readKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (key === "") {
    throw new HarnessError({
      type: "input_validation",
      message: "kv_store requires a non-empty key.",
      nodeName: KV_MCP_TOOL_ID,
    });
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new HarnessError({
      type: "input_validation",
      message: `kv_store key must be at most ${String(MAX_KEY_LENGTH)} characters.`,
      nodeName: KV_MCP_TOOL_ID,
      metadata: { keyLength: key.length },
    });
  }

  return key;
}

function assertKeyWritable(scope: KvScope, key: string): void {
  const reserved = RESERVED_KEYS_BY_SCOPE[scope].has(key)
    || RESERVED_KEY_PREFIXES_BY_SCOPE[scope].some((prefix) => key.startsWith(prefix));

  if (!reserved) {
    return;
  }

  throw new HarnessError({
    type: "input_validation",
    message: `kv_store cannot write "${key}": this key belongs to the workflow runtime.`,
    nodeName: KV_MCP_TOOL_ID,
    metadata: { scope, key },
  });
}

function assertJsonSerializable(value: unknown): void {
  try {
    if (JSON.stringify(value) === undefined) throw new Error("value cannot be represented as JSON");
  } catch (error) {
    throw new HarnessError({
      type: "input_validation",
      message: `kv_store value must be JSON serializable: ${error instanceof Error ? error.message : String(error)}.`,
      nodeName: KV_MCP_TOOL_ID,
    });
  }
}

export const KV_CAPABILITY: Capability = {
  serverId: KV_MCP_SERVER_ID,
  toolName: KV_MCP_TOOL_NAME,
  toolId: KV_MCP_TOOL_ID,
  title: "Workflow KV store",
  description: [
    "Read or write JSON values in the workflow project or conversation KV namespace.",
    "Keys the runtime keeps for itself — tokenUsage.* and, in the conversation namespace, agent.* — are reserved and refused.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["get", "set"], description: "Read one key, or write one." },
      scope: {
        type: "string",
        enum: ["project", "conversation"],
        description: "Project-wide storage, or storage tied to this conversation.",
      },
      key: { type: "string", minLength: 1, maxLength: 500 },
      value: { description: 'The JSON value to store; required when action is "set".' },
    },
    required: ["action", "scope", "key"],
  },
  async run(context, args) {
    return runKvAction(context, args as unknown as KvToolArgs);
  },
};
