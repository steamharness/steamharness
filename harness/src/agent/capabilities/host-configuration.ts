import type { NodeContext } from "../../types/context";
import type { WorkflowCapability } from "./types";

export const HOST_CONFIGURATION_MCP_SERVER_ID = "workflow-host";
export const HOST_CONFIGURATION_MCP_TOOL_NAME = "host_project_configuration";
export const HOST_CONFIGURATION_MCP_TOOL_ID =
  `${HOST_CONFIGURATION_MCP_SERVER_ID}_${HOST_CONFIGURATION_MCP_TOOL_NAME}`;

const HOST_BRIDGE_URL_ENV = "WORKFLOW_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL";
const HOST_BRIDGE_TOKEN_ENV = "WORKFLOW_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN";
const HOST_BRIDGE_TIMEOUT_MS = 15_000;
const MAX_IDENTIFIER_CHARS = 200;

export interface HostConfigurationToolArgs {
  action: "get" | "create" | "update" | "delete";
  configurationId?: string;
  configurationName?: string;
  name?: string;
  values?: Record<string, unknown>;
}

export interface HostBridgeConfig {
  url: string;
  token: string;
}

const HOST_CONFIGURATION_ACTIONS: readonly HostConfigurationToolArgs["action"][] = [
  "get",
  "create",
  "update",
  "delete",
];

/**
 * Reads the loopback bridge a host injects for this run.
 *
 * Only the host may activate this tool. A project with no bridge environment
 * simply does not expose it, and a bridge that is not an authenticated
 * loopback endpoint is refused rather than dialled — the token would
 * otherwise be sent somewhere it does not belong.
 */
export function readHostConfigurationBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): HostBridgeConfig | undefined {
  const rawUrl = env[HOST_BRIDGE_URL_ENV]?.trim();
  const token = env[HOST_BRIDGE_TOKEN_ENV]?.trim();
  if (!rawUrl || !token) return undefined;
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("The developer-assistant host bridge must use an authenticated loopback URL.");
  }
  return { url: url.toString(), token };
}

export async function runHostConfigurationAction(
  args: HostConfigurationToolArgs,
  config: HostBridgeConfig | undefined = readHostConfigurationBridgeConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (!config) {
    throw new Error("Host project configuration is unavailable for this run.");
  }
  if (!HOST_CONFIGURATION_ACTIONS.includes(args.action)) {
    throw new Error(`Host project configuration action is invalid: ${String(args.action)}.`);
  }
  const input = {
    ...(args.configurationId === undefined ? {} : { configurationId: readIdentifier(args.configurationId, "configurationId") }),
    ...(args.configurationName === undefined ? {} : { configurationName: readIdentifier(args.configurationName, "configurationName") }),
    ...(args.name === undefined ? {} : { name: readIdentifier(args.name, "name") }),
    ...(args.values === undefined ? {} : { values: readConfigurationValues(args.values) }),
  };
  return requestHostBridge(`kanban.configuration.${args.action}`, input, config, fetchImpl);
}

export async function requestHostBridge(
  operation: string,
  input: Record<string, unknown>,
  config: HostBridgeConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HOST_BRIDGE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operation,
      input,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json() as unknown;
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
    const message = typeof error.message === "string"
      ? error.message
      : "Host project configuration operation failed.";
    const failure = new Error(message);
    if (typeof error.code === "string") Object.assign(failure, { code: error.code });
    throw failure;
  }
  return payload.value;
}

function readIdentifier(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text.length > MAX_IDENTIFIER_CHARS) {
    throw new Error(
      `Host project configuration ${field} must be 1-${String(MAX_IDENTIFIER_CHARS)} characters.`,
    );
  }

  return text;
}

const MAX_VALUE_KEY_LENGTH = 200;

/**
 * Checks the shape the published schema promises.
 *
 * Nothing validates arguments on the way in — an MCP client is handed the
 * schema but is not obliged to honour it, and the agent SDK treats it as a
 * type assertion — so a malformed key would otherwise travel to the host
 * bridge and come back as the bridge's own vocabulary instead of a
 * validation failure.
 */
function readConfigurationValues(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Host project configuration values must be an object.");
  }

  const values: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length < 1 || key.length > MAX_VALUE_KEY_LENGTH) {
      throw new Error(
        `Host project configuration value keys must be 1-${MAX_VALUE_KEY_LENGTH} characters.`,
      );
    }
    if (
      typeof entry !== "string"
      && typeof entry !== "boolean"
      && !(typeof entry === "number" && Number.isFinite(entry))
      && !(Array.isArray(entry) && entry.every((item) => typeof item === "string"))
    ) {
      throw new Error(
        "Host project configuration values must be strings, finite numbers, booleans, or string arrays.",
      );
    }
    values[key] = entry;
  }

  return values;
}

export const HOST_CONFIGURATION_CAPABILITY: WorkflowCapability = {
  serverId: HOST_CONFIGURATION_MCP_SERVER_ID,
  toolName: HOST_CONFIGURATION_MCP_TOOL_NAME,
  toolId: HOST_CONFIGURATION_MCP_TOOL_ID,
  title: "Host project configuration",
  description: [
    "Create, read, update, or delete Workflow Code host-managed named configurations for the current Kanban project.",
    "Use get before mutations. Update selects by id, exact name, or the active configuration; delete requires an explicit id or exact name.",
    "Create accepts an optional name and partial initial values. Update accepts a new name and/or partial values.",
    "Values use native strings, finite numbers, booleans, or string arrays. File parameters cannot be changed. This does not edit kanban.json.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...HOST_CONFIGURATION_ACTIONS],
        description: "What to do with the named configuration.",
      },
      configurationId: { type: "string", minLength: 1, maxLength: 200 },
      configurationName: { type: "string", minLength: 1, maxLength: 200 },
      name: { type: "string", minLength: 1, maxLength: 200 },
      values: {
        type: "object",
        propertyNames: { type: "string", minLength: 1, maxLength: MAX_VALUE_KEY_LENGTH },
        additionalProperties: {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
    },
    required: ["action"],
  },
  // The bridge is addressed over HTTP, so this one has no use for the node's
  // storage or approval state beyond the approval the caller applies.
  async run(_context: NodeContext, args) {
    return runHostConfigurationAction(args as unknown as HostConfigurationToolArgs);
  },
  // Only the host may activate this one. A bridge that is absent means the
  // host declared nothing, and a bridge that is malformed means it declared
  // something the token must not be sent to; both leave the tool unoffered.
  // The difference is reported by `run`, which is where a caller can still be
  // told about it — an `isAvailable` that threw would take every other
  // capability down with it, because availability is asked for the whole set.
  isAvailable() {
    try {
      return readHostConfigurationBridgeConfig() !== undefined;
    } catch {
      return false;
    }
  },
  describeFailure(error) {
    return isRecord(error) && typeof error.code === "string" ? { code: error.code } : {};
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
