import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * A stdio MCP server the agent should connect to.
 *
 * The shape is the one Desktop already emits for the Project Assistant's
 * control server, so a host can hand its configuration straight through.
 */
export interface McpServerDefinition {
  id: string;
  command: readonly string[];
  /** Literal environment for the child. Sensitive values must be inherited by name instead. */
  environment?: Readonly<Record<string, string>>;
  /** Environment keys copied from the parent process by name. */
  inheritEnvironment?: readonly string[];
  timeout?: number;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema, handed to the agent SDK unchanged. */
  inputSchema: unknown;
}

export interface McpToolCallResult {
  content: unknown;
  isError: boolean;
}

export interface McpServerConnection {
  id: string;
  tools: readonly McpToolDescriptor[];
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export const DEFAULT_MCP_TIMEOUT_MS = 60_000;
export const MAX_MCP_SERVERS = 8;
export const MAX_MCP_TOOLS = 256;

const MAX_COMMAND_PARTS = 64;
const MAX_COMMAND_PART_LENGTH = 8_192;
const MAX_ENV_VALUE_LENGTH = 16_384;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

export interface McpConnectOptions {
  /**
   * Environment keys a server may inherit by name.
   *
   * A host lists the capability-bearing variables it injects per run — an
   * authenticated loopback URL and its token, say — so a scripted config can
   * ask for them without ever carrying the value.
   */
  allowedInheritedEnvKeys?: readonly string[];
  /** Where inherited values are read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Validates server definitions before anything is spawned.
 *
 * Everything here is a boundary a host crosses: an executable path, an
 * environment, a shared secret. Rejecting a malformed definition up front
 * beats discovering it halfway through starting a child process.
 */
export function normalizeMcpServers(
  servers: readonly McpServerDefinition[] | undefined,
  options: McpConnectOptions = {},
): McpServerDefinition[] {
  if (servers === undefined) {
    return [];
  }
  if (!Array.isArray(servers) || servers.length > MAX_MCP_SERVERS) {
    throw new Error(`MCP supports at most ${MAX_MCP_SERVERS} servers.`);
  }

  const allowedInherited = new Set(options.allowedInheritedEnvKeys ?? []);
  const ids = new Set<string>();

  return servers.map((rawServer, index) => {
    if (!isRecord(rawServer)) {
      throw new Error(`MCP server at index ${index} must be an object.`);
    }
    const server = rawServer as unknown as Partial<McpServerDefinition>;
    const id = typeof server.id === "string" ? server.id.trim() : "";
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id)) {
      throw new Error(`MCP server id is invalid: ${id === "" ? "<empty>" : id}`);
    }
    if (ids.has(id)) {
      throw new Error(`MCP server id is duplicated: ${id}`);
    }
    ids.add(id);

    if (
      !Array.isArray(server.command)
      || server.command.length === 0
      || server.command.some((part) => typeof part !== "string" || part.trim() === "")
    ) {
      throw new Error(`MCP server "${id}" requires a non-empty command array.`);
    }
    if (!path.isAbsolute(server.command[0]!)) {
      throw new Error(`MCP server "${id}" command must be absolute.`);
    }
    if (server.command.length > MAX_COMMAND_PARTS || server.command.some((part) => part.length > MAX_COMMAND_PART_LENGTH)) {
      throw new Error(`MCP server "${id}" command is too large.`);
    }

    const environment = normalizeEnvironment(id, server.environment, allowedInherited);
    const inheritEnvironment = normalizeInheritedKeys(id, server.inheritEnvironment, allowedInherited);
    if (
      server.timeout !== undefined
      && (!Number.isSafeInteger(server.timeout) || server.timeout < MIN_TIMEOUT_MS || server.timeout > MAX_TIMEOUT_MS)
    ) {
      throw new Error(`MCP server "${id}" timeout is invalid.`);
    }

    return {
      id,
      command: [...server.command],
      ...(environment === undefined ? {} : { environment }),
      ...(inheritEnvironment === undefined ? {} : { inheritEnvironment }),
      ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
    };
  });
}

function normalizeEnvironment(
  id: string,
  value: unknown,
  allowedInherited: ReadonlySet<string>,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`MCP server "${id}" environment is invalid.`);
  }

  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof entry !== "string") {
      throw new Error(`MCP server "${id}" environment is invalid.`);
    }
    if (allowedInherited.has(key)) {
      // A capability the host injects per run must travel by name, so its value
      // never has to be written into a configuration that may be logged.
      throw new Error(`MCP server "${id}" must inherit sensitive environment key "${key}" by name.`);
    }
    if (entry.length > MAX_ENV_VALUE_LENGTH) {
      throw new Error(`MCP server "${id}" environment value is too large.`);
    }
    environment[key] = entry;
  }

  return environment;
}

function normalizeInheritedKeys(
  id: string,
  value: unknown,
  allowedInherited: ReadonlySet<string>,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value)
    || value.length > allowedInherited.size
    || new Set(value).size !== value.length
    || value.some((key) => typeof key !== "string" || !allowedInherited.has(key))
  ) {
    throw new Error(`MCP server "${id}" inherited environment is invalid.`);
  }

  return [...(value as string[])];
}

export function readInheritedMcpEnvironment(
  definition: McpServerDefinition,
  env: NodeJS.ProcessEnv = process.env,
  allowedInheritedEnvKeys: readonly string[] = [],
): Record<string, string> {
  const allowed = new Set(allowedInheritedEnvKeys);
  const environment: Record<string, string> = {};

  for (const key of definition.inheritEnvironment ?? []) {
    if (!allowed.has(key)) {
      throw new Error(`MCP server "${definition.id}" may not inherit "${key}".`);
    }
    const value = env[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`MCP inherited environment key "${key}" is unavailable.`);
    }
    environment[key] = value;
  }

  return environment;
}

/**
 * Starts one stdio MCP server and lists what it exposes.
 *
 * The SDK is imported on demand: most consumers never touch MCP, and the
 * package is bundled for the ones that do.
 */
export async function connectMcpServer(
  definition: McpServerDefinition,
  options: McpConnectOptions = {},
): Promise<McpServerConnection> {
  const [normalized] = normalizeMcpServers([definition], options);
  if (normalized === undefined) {
    throw new Error("MCP server is missing.");
  }

  const [{ Client }, { StdioClientTransport, getDefaultEnvironment }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);

  const [command, ...args] = normalized.command;
  const transport = new StdioClientTransport({
    command: command!,
    args,
    env: {
      ...getDefaultEnvironment(),
      ...normalized.environment,
      ...readInheritedMcpEnvironment(normalized, options.env, options.allowedInheritedEnvKeys),
    },
    stderr: "pipe",
  });
  // A child that fills its stderr pipe would otherwise block forever.
  (transport.stderr as { resume?(): void } | null)?.resume?.();

  const client = new Client({ name: "workflow-code-agent", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const tools = await listMcpTools(client, normalized.id, normalized.timeout);
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) {
        throw new Error(`MCP server "${normalized.id}" returned duplicate tool "${tool.name}".`);
      }
      names.add(tool.name);
    }

    return {
      id: normalized.id,
      tools,
      async callTool(name, callArgs, signal) {
        if (!names.has(name)) {
          throw new Error(`MCP server "${normalized.id}" does not expose tool "${name}".`);
        }
        const result = await client.callTool({ name, arguments: callArgs }, undefined, {
          signal,
          timeout: normalized.timeout ?? DEFAULT_MCP_TIMEOUT_MS,
        }) as { content?: unknown; isError?: boolean };
        return { content: result.content ?? [], isError: result.isError === true };
      },
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function listMcpTools(
  client: Client,
  serverId: string,
  timeout: number | undefined,
): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  do {
    const response = await client.listTools(cursor === undefined ? undefined : { cursor }, {
      timeout: timeout ?? DEFAULT_MCP_TIMEOUT_MS,
    });
    // Checked before the page is copied over: a server that publishes a page of
    // a hundred thousand tools should not get to decide how much memory this
    // holds before the limit that exists to stop it is consulted.
    if (tools.length + response.tools.length > MAX_MCP_TOOLS) {
      throw new Error(`MCP supports at most ${MAX_MCP_TOOLS} tools per server.`);
    }
    for (const tool of response.tools) {
      tools.push({
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      });
    }

    cursor = response.nextCursor;

    // The server decides when the listing ends, and a server that says "there
    // is more" forever would otherwise keep this loop — and the process — here
    // until the per-request timeout fires, over and over. An empty cursor is
    // the one a careful server uses to mean the same thing as no cursor at
    // all, and a repeat is a cycle rather than progress.
    if (cursor === undefined || cursor === "") break;
    if (seen.has(cursor)) {
      throw new Error(`MCP server "${serverId}" repeated a tool-listing cursor.`);
    }
    seen.add(cursor);
  } while (true);

  return tools;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
