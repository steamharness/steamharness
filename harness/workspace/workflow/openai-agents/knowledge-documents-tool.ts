import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentToolCallSummary } from "./interface";

interface KnowledgeDocumentsToolContext {
  storage: {
    local: {
      persistentValue: {
        getValue(key: string): Promise<unknown | undefined>;
        setValue(key: string, value: unknown): Promise<void>;
        updateValue(key: string, updater: (current: unknown | undefined) => unknown): Promise<unknown>;
      };
    };
  };
}

type KnowledgeDocumentsAction = "list" | "get" | "create" | "edit" | "delete" | "search" | "read_lines";

interface KnowledgeDocumentsToolArgs {
  action: KnowledgeDocumentsAction;
  documentId?: string;
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

export function createKnowledgeDocumentsTool(input: {
  context: KnowledgeDocumentsToolContext;
  toolEvents: AgentToolCallSummary[];
}) {
  return tool({
    name: "knowledge_documents",
    description: [
      "Manage PersistentValue-backed project markdown knowledge documents.",
      "Use action=list to see summaries, get to read one document, create/edit/delete to change documents, search to find matching markdown lines, and read_lines for a 1-based inclusive line range.",
    ].join(" "),
    parameters: z.object({
      action: z.enum(["list", "get", "create", "edit", "delete", "search", "read_lines"]),
      documentId: z.string().min(1).max(200).optional(),
      title: z.string().min(1).max(200).optional(),
      markdown: z.string().max(200_000).optional(),
      query: z.string().min(1).max(500).optional(),
      beforeLines: z.number().int().min(0).max(50).optional(),
      afterLines: z.number().int().min(0).max(50).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      cursor: z.string().min(1).max(80).optional(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
      includeMarkdown: z.boolean().optional(),
      maxMarkdownLength: z.number().int().min(100).max(20_000).optional(),
    }),
    async execute(args) {
      // Project knowledge documents use PersistentValue-backed helpers and
      // never fall back to ordinary local KV.
      const result = await runKnowledgeDocumentsAction(input.context, args);
      input.toolEvents.push({ name: "knowledge_documents", status: "completed" });
      return result;
    },
  });
}

async function runKnowledgeDocumentsAction(
  context: KnowledgeDocumentsToolContext,
  args: KnowledgeDocumentsToolArgs,
) {
  const projectContext = context as Parameters<typeof steamharness.listKnowledgeDocuments>[0];

  switch (args.action) {
    case "list": {
      const { items: documents } = await projectContext.databases.get("data").knowledge.listDocuments();
      return {
        action: "list",
        count: documents.length,
        documents,
      };
    }
    case "get": {
      const documentId = requireToolString(args.documentId, "documentId", args.action);
      const document = await projectContext.databases.get("data").knowledge.getDocument(documentId);
      return {
        action: "get",
        found: document !== undefined,
        document: document === undefined ? undefined : summarizeKnowledgeDocument(document, {
          includeMarkdown: args.includeMarkdown !== false,
          maxMarkdownLength: args.maxMarkdownLength,
        }),
      };
    }
    case "create": {
      const document = await projectContext.databases.get("data").knowledge.createDocument({
        id: normalizeOptionalString(args.documentId),
        title: requireToolString(args.title, "title", args.action),
        markdown: requireToolString(args.markdown, "markdown", args.action),
      });
      return {
        action: "create",
        document: summarizeKnowledgeDocument(document, {
          includeMarkdown: args.includeMarkdown === true,
          maxMarkdownLength: args.maxMarkdownLength,
        }),
      };
    }
    case "edit": {
      const document = await projectContext.databases.get("data").knowledge.editDocument({
        id: requireToolString(args.documentId, "documentId", args.action),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.markdown === undefined ? {} : { markdown: args.markdown }),
      });
      return {
        action: "edit",
        document: summarizeKnowledgeDocument(document, {
          includeMarkdown: args.includeMarkdown === true,
          maxMarkdownLength: args.maxMarkdownLength,
        }),
      };
    }
    case "delete": {
      return {
        action: "delete",
        ...await projectContext.databases.get("data").knowledge.deleteDocument(requireToolString(args.documentId, "documentId", args.action),
        ),
      };
    }
    case "search": {
      return {
        action: "search",
        ...await projectContext.databases.get("data").knowledge.searchDocuments({
          query: requireToolString(args.query, "query", args.action),
          ...(args.documentId === undefined ? {} : { documentId: args.documentId }),
          beforeLines: args.beforeLines,
          afterLines: args.afterLines,
          pageSize: args.pageSize,
          cursor: args.cursor,
        }),
      };
    }
    case "read_lines": {
      return {
        action: "read_lines",
        ...await projectContext.databases.get("data").knowledge.readDocumentLines({
          documentId: requireToolString(args.documentId, "documentId", args.action),
          startLine: requireToolNumber(args.startLine, "startLine", args.action),
          endLine: requireToolNumber(args.endLine, "endLine", args.action),
        }),
      };
    }
    default:
      throw new steamharness.HarnessError({
        type: "input_validation",
        message: `Unsupported knowledge_documents action: ${String(args.action)}.`,
        nodeName: "openai-agents-output",
      });
  }
}

function summarizeKnowledgeDocument(
  document: {
    id: string;
    title: string;
    markdown: string;
    createdAt: string;
    updatedAt: string;
  },
  options: {
    includeMarkdown: boolean;
    maxMarkdownLength?: number;
  },
) {
  const markdownLength = document.markdown.length;
  const lineCount = document.markdown.split(/\r?\n/).length;
  return {
    id: document.id,
    title: document.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    markdownLength,
    lineCount,
    markdownPreview: truncateKnowledgeMarkdown(document.markdown, 500),
    ...(options.includeMarkdown
      ? {
          markdown: truncateKnowledgeMarkdown(
            document.markdown,
            options.maxMarkdownLength ?? 8_000,
          ),
          markdownTruncated: markdownLength > (options.maxMarkdownLength ?? 8_000),
        }
      : {}),
  };
}

function truncateKnowledgeMarkdown(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[markdown truncated]`;
}

function requireToolString(
  value: string | undefined,
  field: string,
  action: string,
): string {
  const normalized = normalizeOptionalString(value);
  if (normalized !== undefined) {
    return normalized;
  }

  throw new steamharness.HarnessError({
    type: "input_validation",
    message: `knowledge_documents action "${action}" requires ${field}.`,
    nodeName: "openai-agents-output",
    metadata: { action, field },
  });
}

function requireToolNumber(
  value: number | undefined,
  field: string,
  action: string,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new steamharness.HarnessError({
    type: "input_validation",
    message: `knowledge_documents action "${action}" requires ${field}.`,
    nodeName: "openai-agents-output",
    metadata: { action, field },
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
