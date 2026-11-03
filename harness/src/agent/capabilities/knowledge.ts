import { HarnessError } from "../../workflow/errors";
import type { NodeContext } from "../../types/context";
import type { Capability } from "./types";
import { pageInteger, pageJsonResult, RESULT_PAGE_DESCRIPTION, RESULT_PAGE_PROPERTIES, splitsSurrogate,
  validateResultPageArgs, type ResultPageArgs } from "../result-pages";

export const KNOWLEDGE_MCP_SERVER_ID = "workflow-knowledge";
export const KNOWLEDGE_MCP_TOOL_NAME = "knowledge_documents";
export const KNOWLEDGE_MCP_TOOL_ID = `${KNOWLEDGE_MCP_SERVER_ID}_${KNOWLEDGE_MCP_TOOL_NAME}`;

type KnowledgeAction = "list" | "get" | "create" | "edit" | "delete" | "search" | "read_lines";

const KNOWLEDGE_ACTIONS: readonly KnowledgeAction[] = [
  "list",
  "get",
  "create",
  "edit",
  "delete",
  "search",
  "read_lines",
];

interface KnowledgeToolArgs extends ResultPageArgs {
  knowledgeBase: string;
  action: KnowledgeAction;
  documentId?: string;
  expectedRevision?: number;
  title?: string;
  markdown?: string;
  query?: string;
  beforeLines?: number;
  afterLines?: number;
  pageSize?: number;
  cursor?: string;
  startLine?: number;
  endLine?: number;
  includeMarkdown?: boolean;
  maxMarkdownLength?: number;
}

export async function runKnowledgeAction(
  context: Pick<NodeContext, "knowledgeBases">,
  args: KnowledgeToolArgs,
): Promise<unknown> {
  const readOnly = ["get", "list", "search", "read_lines"].includes(args.action);
  validateResultPageArgs(args, readOnly);
  if (args.maxMarkdownLength !== undefined) pageInteger(args.maxMarkdownLength, 8000, "maxMarkdownLength", 100, 20_000);
  if (args.includeMarkdown !== undefined && typeof args.includeMarkdown !== "boolean") throw new HarnessError({ type: "input_validation", message: "includeMarkdown must be a boolean.", nodeName: KNOWLEDGE_MCP_TOOL_ID });
  const result = await runKnowledgeActionResult(context, args);
  return readOnly ? pageJsonResult(result, args) : result;
}

async function runKnowledgeActionResult(
  context: Pick<NodeContext, "knowledgeBases">,
  args: KnowledgeToolArgs,
): Promise<unknown> {
  if (!KNOWLEDGE_ACTIONS.includes(args.action)) {
    throw new HarnessError({
      type: "input_validation",
      message: `knowledge_documents action is invalid: ${String(args.action)}.`,
      nodeName: KNOWLEDGE_MCP_TOOL_ID,
    });
  }

  if (args.expectedRevision !== undefined) pageInteger(args.expectedRevision, 1, "expectedRevision", 1, 2147483647);
  const storage = context.knowledgeBases.get(requireString(args.knowledgeBase, "knowledgeBase", args.action));
  switch (args.action) {
    case "list": {
      const page = await storage.listDocuments({ pageSize: args.pageSize, cursor: args.cursor });
      return { action: "list" as const, count: page.total, documents: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor };
    }
    case "get": {
      const document = await storage.getDocument(
        requireString(args.documentId, "documentId", args.action),
      );
      return {
        action: "get" as const,
        found: document !== undefined,
        document: document === undefined
          ? undefined
          : summarizeDocument(document, {
              includeMarkdown: args.includeMarkdown !== false,
              maxMarkdownLength: args.maxMarkdownLength,
            }),
      };
    }
    case "create": {
      const document = await storage.createDocument( {
        id: optionalBoundedString(args.documentId, "documentId", args.action),
        title: requireString(args.title, "title", args.action),
        markdown: requireString(args.markdown, "markdown", args.action),
      });
      return {
        action: "create" as const,
        document: summarizeDocument(document, {
          includeMarkdown: args.includeMarkdown === true,
          maxMarkdownLength: Math.min(args.maxMarkdownLength ?? 8000, 4000),
        }),
      };
    }
    case "edit": {
      const title = optionalBoundedString(args.title, "title", args.action);
      const markdown = optionalBoundedString(args.markdown, "markdown", args.action);
      const document = await storage.editDocument( {
        id: requireString(args.documentId, "documentId", args.action),
        ...(title === undefined ? {} : { title }),
        ...(markdown === undefined ? {} : { markdown }),
        ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
      });
      return {
        action: "edit" as const,
        document: summarizeDocument(document, {
          includeMarkdown: args.includeMarkdown === true,
          maxMarkdownLength: Math.min(args.maxMarkdownLength ?? 8000, 4000),
        }),
      };
    }
    case "delete":
      return {
        action: "delete" as const,
        ...(await storage.deleteDocument(
          requireString(args.documentId, "documentId", args.action), args.expectedRevision,
        )),
      };
    case "search": {
      const documentId = optionalBoundedString(args.documentId, "documentId", args.action);
      const cursor = optionalBoundedString(args.cursor, "cursor", args.action);
      return {
        action: "search" as const,
        ...(await storage.searchDocuments( {
          query: requireString(args.query, "query", args.action),
          ...(documentId === undefined ? {} : { documentId }),
          beforeLines: args.beforeLines,
          afterLines: args.afterLines,
          pageSize: args.pageSize,
          ...(cursor === undefined ? {} : { cursor }),
        })),
      };
    }
    case "read_lines":
      return {
        action: "read_lines" as const,
        ...(await storage.readDocumentLines( {
          documentId: requireString(args.documentId, "documentId", args.action),
          startLine: requireNumber(args.startLine, "startLine", args.action),
          endLine: requireNumber(args.endLine, "endLine", args.action),
        })),
      };
  }
}

function summarizeDocument(
  document: { id: string; title: string; markdown: string; createdAt: string; updatedAt: string; revision?: number },
  options: { includeMarkdown: boolean; maxMarkdownLength?: number },
) {
  const maxMarkdownLength = options.maxMarkdownLength ?? 8_000;
  return {
    id: document.id,
    ...(document.revision === undefined ? {} : { revision: document.revision }),
    title: document.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    markdownLength: document.markdown.length,
    lineCount: document.markdown.split(/\r?\n/).length,
    markdownPreview: truncateMarkdown(document.markdown, 500),
    ...(options.includeMarkdown ? {
      markdown: truncateMarkdown(document.markdown, maxMarkdownLength),
      markdownTruncated: document.markdown.length > maxMarkdownLength,
    } : {}),
  };
}

function truncateMarkdown(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, splitsSurrogate(value, maxLength) ? maxLength - 1 : maxLength)}\n[markdown truncated]`;
}

/**
 * The bounds the published schema promises.
 *
 * Nothing else enforces them: an MCP client is handed the schema but is not
 * obliged to honour it, and the agent SDK treats it as a type assertion, so a
 * document body would otherwise travel as far as the store.
 */
const MAX_IDENTIFIER_CHARS = 200;
const MAX_MARKDOWN_CHARS = 200_000;
const MAX_QUERY_CHARS = 500;
const MAX_CURSOR_CHARS = 4096;

const STRING_BOUNDS: Readonly<Record<string, number>> = {
  documentId: MAX_IDENTIFIER_CHARS,
  title: MAX_IDENTIFIER_CHARS,
  markdown: MAX_MARKDOWN_CHARS,
  query: MAX_QUERY_CHARS,
  cursor: MAX_CURSOR_CHARS,
};

function requireString(value: unknown, field: string, action: KnowledgeAction): string {
  const normalized = optionalString(value);
  if (normalized !== undefined) return assertWithinBounds(normalized, field, action);
  throw new HarnessError({
    type: "input_validation",
    message: `knowledge_documents action "${action}" requires ${field}.`,
    nodeName: KNOWLEDGE_MCP_TOOL_ID,
    metadata: { action, field },
  });
}

function optionalBoundedString(
  value: unknown,
  field: string,
  action: KnowledgeAction,
): string | undefined {
  const normalized = optionalString(value);
  return normalized === undefined ? undefined : assertWithinBounds(normalized, field, action);
}

function assertWithinBounds(value: string, field: string, action: KnowledgeAction): string {
  const limit = STRING_BOUNDS[field];
  if (limit !== undefined && value.length > limit) {
    throw new HarnessError({
      type: "input_validation",
      message: `knowledge_documents ${field} must be at most ${String(limit)} characters.`,
      nodeName: KNOWLEDGE_MCP_TOOL_ID,
      metadata: { action, field, length: value.length },
    });
  }

  return value;
}

function requireNumber(value: unknown, field: string, action: KnowledgeAction): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new HarnessError({
    type: "input_validation",
    message: `knowledge_documents action "${action}" requires ${field}.`,
    nodeName: KNOWLEDGE_MCP_TOOL_ID,
    metadata: { action, field },
  });
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export const KNOWLEDGE_CAPABILITY: Capability = {
  serverId: KNOWLEDGE_MCP_SERVER_ID,
  toolName: KNOWLEDGE_MCP_TOOL_NAME,
  toolId: KNOWLEDGE_MCP_TOOL_ID,
  title: "Knowledge documents",
  description: [
    "Manage project Markdown knowledge documents stored by steamharness.",
    "Use list/get/search/read_lines to inspect documents and create/edit/delete to change them.",
    "Large Markdown bodies are truncated; use read_lines for precise ranges.",
    RESULT_PAGE_DESCRIPTION,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      knowledgeBase: { type: "string", minLength: 1, description: "The declared knowledge base alias." },
      action: {
        type: "string",
        enum: [...KNOWLEDGE_ACTIONS],
        description: "What to do with the document store.",
      },
      documentId: { type: "string", minLength: 1, maxLength: 200 },
      expectedRevision: { type: "integer", minimum: 1, maximum: 2147483647, description: "The document revision read before editing or deleting." },
      title: { type: "string", minLength: 1, maxLength: 200 },
      markdown: { type: "string", maxLength: 200_000 },
      query: { type: "string", minLength: 1, maxLength: 500 },
      beforeLines: { type: "integer", minimum: 0, maximum: 50 },
      afterLines: { type: "integer", minimum: 0, maximum: 50 },
      pageSize: { type: "integer", minimum: 1, maximum: 1000 },
      cursor: { type: "string", minLength: 1, maxLength: 4096 },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      includeMarkdown: { type: "boolean", description: "Include the body, truncated." },
      maxMarkdownLength: { type: "integer", minimum: 100, maximum: 20_000 },
      ...RESULT_PAGE_PROPERTIES,
    },
    required: ["knowledgeBase", "action"],
  },
  async run(context, args) {
    return runKnowledgeAction(context, args as unknown as KnowledgeToolArgs);
  },
  describeFailure(error) {
    return {
      metadata: error instanceof HarnessError ? error.metadata ?? null : undefined,
    };
  },
};
