import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  editKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  searchKnowledgeDocuments,
} from "../../knowledge/index";
import { HarnessError } from "../../workflow/errors";
import type { NodeContext } from "../../types/context";
import { selectWorkflowStorage } from "./storage";
import type { Capability } from "./types";

export const GLOBAL_MEMORY_MCP_SERVER_ID = "workflow-memory";
export const GLOBAL_MEMORY_MCP_TOOL_NAME = "global_memory";
export const GLOBAL_MEMORY_MCP_TOOL_ID = `${GLOBAL_MEMORY_MCP_SERVER_ID}_${GLOBAL_MEMORY_MCP_TOOL_NAME}`;

const MEMORY_DOCUMENT_PREFIX = "assistant-memory-";
const MEMORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;

type GlobalMemoryAction = "list" | "get" | "search" | "remember" | "forget";

const GLOBAL_MEMORY_ACTIONS: readonly GlobalMemoryAction[] = [
  "list",
  "get",
  "search",
  "remember",
  "forget",
];

export interface GlobalMemoryToolArgs {
  action: GlobalMemoryAction;
  memoryId?: string;
  title?: string;
  markdown?: string;
  query?: string;
  pageSize?: number;
  cursor?: string;
}

/**
 * Durable memory, kept in the knowledge store under a reserved id prefix.
 *
 * Reusing the document store means memory inherits its storage placement,
 * its search and its deletion semantics rather than reimplementing them; the
 * prefix is what keeps the two apart.
 */
export async function runGlobalMemoryAction(
  context: Pick<NodeContext, "storage">,
  args: GlobalMemoryToolArgs,
): Promise<unknown> {
  if (!GLOBAL_MEMORY_ACTIONS.includes(args.action)) {
    throw new HarnessError({
      type: "input_validation",
      message: `global_memory action is invalid: ${String(args.action)}.`,
      nodeName: GLOBAL_MEMORY_MCP_TOOL_ID,
    });
  }

  const storage = selectWorkflowStorage(context);
  switch (args.action) {
    case "list": {
      const memories = (await listKnowledgeDocuments(storage))
        .filter((item) => item.id.startsWith(MEMORY_DOCUMENT_PREFIX));
      const offset = readListCursor(args.cursor);
      const pageSize = args.pageSize ?? 50;
      const items = memories.slice(offset, offset + pageSize);
      const nextOffset = offset + items.length;
      const hasMore = nextOffset < memories.length;
      return {
        action: "list" as const,
        memories: items.map(stripMemoryPrefix),
        // The same field carries two kinds of cursor — an offset here, the
        // knowledge store's own token for `search` — so each is labelled with
        // the action it came from and a cursor from the other is refused
        // rather than read as something it is not.
        nextCursor: hasMore ? `${LIST_CURSOR_PREFIX}${String(nextOffset)}` : undefined,
        hasMore,
      };
    }
    case "get": {
      const memoryId = requireMemoryId(args.memoryId, args.action);
      const document = await getKnowledgeDocument(storage, memoryDocumentId(memoryId));
      return {
        action: "get" as const,
        found: document !== undefined,
        memory: document === undefined ? undefined : stripMemoryPrefix(document),
      };
    }
    case "search": {
      const cursor = readSearchCursor(args.cursor);
      const result = await searchKnowledgeDocuments(storage, {
        query: requireString(args.query, "query", args.action),
        pageSize: args.pageSize ?? 50,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const matches = result.matches
        .filter((match) => match.documentId.startsWith(MEMORY_DOCUMENT_PREFIX))
        .map((match) => ({
          ...match,
          memoryId: match.documentId.slice(MEMORY_DOCUMENT_PREFIX.length),
        }));
      return {
        ...result,
        action: "search" as const,
        matches,
        ...(result.nextCursor === undefined
          ? {}
          : { nextCursor: `${SEARCH_CURSOR_PREFIX}${result.nextCursor}` }),
      };
    }
    case "remember": {
      const memoryId = requireMemoryId(args.memoryId, args.action);
      const title = requireString(args.title, "title", args.action);
      const markdown = requireString(args.markdown, "markdown", args.action);
      assertNoLikelySecret(`${title}\n${markdown}`);
      const documentId = memoryDocumentId(memoryId);
      const existing = await getKnowledgeDocument(storage, documentId);
      const document = existing === undefined
        ? await createKnowledgeDocument(storage, { id: documentId, title, markdown })
        : await editKnowledgeDocument(storage, { id: documentId, title, markdown });
      return { action: "remember" as const, memory: stripMemoryPrefix(document) };
    }
    case "forget": {
      const memoryId = requireMemoryId(args.memoryId, args.action);
      return {
        action: "forget" as const,
        memoryId,
        ...(await deleteKnowledgeDocument(storage, memoryDocumentId(memoryId))),
      };
    }
  }
}

function requireMemoryId(value: unknown, action: GlobalMemoryAction): string {
  const memoryId = requireString(value, "memoryId", action).toLowerCase();
  if (!MEMORY_ID_PATTERN.test(memoryId)) {
    throw new HarnessError({
      type: "input_validation",
      message: "global_memory memoryId must use lowercase letters, numbers, dots, underscores, or hyphens.",
      nodeName: GLOBAL_MEMORY_MCP_TOOL_ID,
    });
  }
  return memoryId;
}

/** Marks which action a cursor came from, so `list` and `search` cannot be crossed. */
const LIST_CURSOR_PREFIX = "list:";
const SEARCH_CURSOR_PREFIX = "search:";

/** The string bounds the published schema promises; nothing else enforces them. */
const STRING_BOUNDS: Readonly<Record<string, number>> = {
  title: 200,
  markdown: 100_000,
  query: 500,
  cursor: 200,
};

function requireString(value: unknown, field: string, action: GlobalMemoryAction): string {
  if (typeof value === "string" && value.trim() !== "") {
    return assertWithinBounds(value.trim(), field, action);
  }
  throw new HarnessError({
    type: "input_validation",
    message: `global_memory action "${action}" requires ${field}.`,
    nodeName: GLOBAL_MEMORY_MCP_TOOL_ID,
  });
}

function assertWithinBounds(value: string, field: string, action: GlobalMemoryAction): string {
  const limit = STRING_BOUNDS[field];
  if (limit !== undefined && value.length > limit) {
    throw new HarnessError({
      type: "input_validation",
      message: `global_memory ${field} must be at most ${String(limit)} characters.`,
      nodeName: GLOBAL_MEMORY_MCP_TOOL_ID,
      metadata: { action, field, length: value.length },
    });
  }

  return value;
}

function assertNoLikelySecret(markdown: string): void {
  const secretPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
    /\b(?:sk|ghp|glpat)-[A-Za-z0-9_-]{16,}\b/i,
    /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s`]{12,}/i,
  ];
  if (secretPatterns.some((pattern) => pattern.test(markdown))) {
    throw new HarnessError({
      type: "input_validation",
      message: "Global memory rejected content that looks like a credential or secret.",
      nodeName: GLOBAL_MEMORY_MCP_TOOL_ID,
    });
  }
}

function memoryDocumentId(memoryId: string): string {
  return `${MEMORY_DOCUMENT_PREFIX}${memoryId}`;
}

function readListCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  assertNotForeignCursor(value, "list");
  const raw = value.startsWith(LIST_CURSOR_PREFIX) ? value.slice(LIST_CURSOR_PREFIX.length) : value;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === raw) return parsed;
  throw new HarnessError({
    type: "input_validation",
    message: "global_memory cursor is invalid for action \"list\".",
    nodeName: GLOBAL_MEMORY_MCP_TOOL_ID,
  });
}

function readSearchCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  assertNotForeignCursor(value, "search");
  return value.startsWith(SEARCH_CURSOR_PREFIX) ? value.slice(SEARCH_CURSOR_PREFIX.length) : value;
}

function assertNotForeignCursor(value: string, action: GlobalMemoryAction): void {
  const expected = action === "list" ? LIST_CURSOR_PREFIX : SEARCH_CURSOR_PREFIX;
  const foreign = action === "list" ? SEARCH_CURSOR_PREFIX : LIST_CURSOR_PREFIX;
  if (!value.startsWith(foreign)) return;

  throw new HarnessError({
    type: "input_validation",
    message: `global_memory cursor belongs to another action; use the cursor ${expected} returned.`,
    nodeName: GLOBAL_MEMORY_MCP_TOOL_ID,
    metadata: { action },
  });
}

function stripMemoryPrefix<T extends { id: string }>(document: T): Omit<T, "id"> & { memoryId: string } {
  const { id, ...rest } = document;
  return { ...rest, memoryId: id.slice(MEMORY_DOCUMENT_PREFIX.length) };
}

export const GLOBAL_MEMORY_CAPABILITY: Capability = {
  serverId: GLOBAL_MEMORY_MCP_SERVER_ID,
  toolName: GLOBAL_MEMORY_MCP_TOOL_NAME,
  toolId: GLOBAL_MEMORY_MCP_TOOL_ID,
  title: "Global memory",
  description: [
    "Read and maintain durable user preferences, project decisions, and requested changes for the developer assistant.",
    "Use remember only for stable, reusable information. Never store credentials, secrets, or transient task progress.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...GLOBAL_MEMORY_ACTIONS],
        description: "What to do with the memory store.",
      },
      memoryId: { type: "string", minLength: 1, maxLength: 120 },
      title: { type: "string", minLength: 1, maxLength: 200 },
      markdown: { type: "string", minLength: 1, maxLength: 100_000 },
      query: { type: "string", minLength: 1, maxLength: 500 },
      pageSize: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["action"],
  },
  async run(context, args) {
    return runGlobalMemoryAction(context, args as unknown as GlobalMemoryToolArgs);
  },
};
