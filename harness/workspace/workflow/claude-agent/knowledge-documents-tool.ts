import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

type KnowledgeDocumentsAction =
  | "list"
  | "get"
  | "create"
  | "edit"
  | "delete"
  | "search"
  | "read_lines";

interface KnowledgeDocumentsToolContext {
  // We only need the PersistentValue slice that the workflow knowledge helpers
  // reach into, but we type against the full WorkflowContext so the helpers
  // accept it directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}

export const KNOWLEDGE_DOCUMENTS_TOOL_NAME = "knowledge_documents";
export const KNOWLEDGE_DOCUMENTS_MCP_SERVER_NAME = "workflow-knowledge-documents";

export function createKnowledgeDocumentsTools(input: KnowledgeDocumentsToolContext) {
  return [
    tool(
      KNOWLEDGE_DOCUMENTS_TOOL_NAME,
      [
        "Manage PersistentValue-backed project markdown knowledge documents.",
        "Use action=list to see summaries, get to read one document, create/edit/delete to change documents, search to find matching markdown lines, and read_lines for a 1-based inclusive line range.",
        "Before invoking this tool, tell the user in normal assistant text which knowledge document operation you are about to perform and why.",
      ].join(" "),
      {
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
      },
      async (args) => {
        try {
          const result = await runKnowledgeDocumentsAction(input.context, args);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result),
              },
            ],
          };
        } catch (error) {
          return formatToolError(error, args.action);
        }
      },
    ),
  ];
}

export function createKnowledgeDocumentsMcpServer(input: KnowledgeDocumentsToolContext) {
  return createSdkMcpServer({
    name: KNOWLEDGE_DOCUMENTS_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: createKnowledgeDocumentsTools(input),
  });
}

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

async function runKnowledgeDocumentsAction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflowContext: any,
  args: KnowledgeDocumentsToolArgs,
) {
  switch (args.action) {
    case "list": {
      const documents = await workflow.listKnowledgeDocuments(workflowContext.storage.local);
      return {
        action: "list" as const,
        count: documents.length,
        documents,
      };
    }
    case "get": {
      const documentId = requireToolString(args.documentId, "documentId", args.action);
      const document = await workflow.getKnowledgeDocument(workflowContext.storage.local, documentId);
      return {
        action: "get" as const,
        found: document !== undefined,
        document:
          document === undefined
            ? undefined
            : summarizeKnowledgeDocument(document, {
                includeMarkdown: args.includeMarkdown !== false,
                maxMarkdownLength: args.maxMarkdownLength,
              }),
      };
    }
    case "create": {
      const document = await workflow.createKnowledgeDocument(workflowContext.storage.local, {
        id: normalizeOptionalString(args.documentId),
        title: requireToolString(args.title, "title", args.action),
        markdown: requireToolString(args.markdown, "markdown", args.action),
      });
      return {
        action: "create" as const,
        document: summarizeKnowledgeDocument(document, {
          includeMarkdown: args.includeMarkdown === true,
          maxMarkdownLength: args.maxMarkdownLength,
        }),
      };
    }
    case "edit": {
      const document = await workflow.editKnowledgeDocument(workflowContext.storage.local, {
        id: requireToolString(args.documentId, "documentId", args.action),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.markdown === undefined ? {} : { markdown: args.markdown }),
      });
      return {
        action: "edit" as const,
        document: summarizeKnowledgeDocument(document, {
          includeMarkdown: args.includeMarkdown === true,
          maxMarkdownLength: args.maxMarkdownLength,
        }),
      };
    }
    case "delete": {
      return {
        action: "delete" as const,
        ...(await workflow.deleteKnowledgeDocument(
          workflowContext.storage.local,
          requireToolString(args.documentId, "documentId", args.action),
        )),
      };
    }
    case "search": {
      return {
        action: "search" as const,
        ...(await workflow.searchKnowledgeDocuments(workflowContext.storage.local, {
          query: requireToolString(args.query, "query", args.action),
          ...(args.documentId === undefined ? {} : { documentId: args.documentId }),
          beforeLines: args.beforeLines,
          afterLines: args.afterLines,
          pageSize: args.pageSize,
          cursor: args.cursor,
        })),
      };
    }
    case "read_lines": {
      return {
        action: "read_lines" as const,
        ...(await workflow.readKnowledgeDocumentLines(workflowContext.storage.local, {
          documentId: requireToolString(args.documentId, "documentId", args.action),
          startLine: requireToolNumber(args.startLine, "startLine", args.action),
          endLine: requireToolNumber(args.endLine, "endLine", args.action),
        })),
      };
    }
    default:
      throw new workflow.WorkflowError({
        type: "input_validation",
        message: `Unsupported knowledge_documents action: ${String(args.action)}.`,
        nodeName: "claude-agent-output",
        metadata: { action: String(args.action) },
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

  throw new workflow.WorkflowError({
    type: "input_validation",
    message: `knowledge_documents action "${action}" requires ${field}.`,
    nodeName: "claude-agent-output",
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

  throw new workflow.WorkflowError({
    type: "input_validation",
    message: `knowledge_documents action "${action}" requires ${field}.`,
    nodeName: "claude-agent-output",
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

function formatToolError(error: unknown, action: KnowledgeDocumentsAction) {
  if (error instanceof workflow.WorkflowError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            action,
            errCode: 1,
            errMessage: error.message,
            metadata: error.metadata ?? null,
          }),
        },
      ],
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ action, errCode: 1, errMessage: message }),
      },
    ],
  };
}
