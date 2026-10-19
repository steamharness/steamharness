import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiAgentSessionEvent } from "./interface";
import { createToolApprovalDecisionChunks } from "./output-items";

type KnowledgeDocumentsAction =
  | "list"
  | "get"
  | "create"
  | "edit"
  | "delete"
  | "search"
  | "read_lines";

interface KnowledgeDocumentsToolContext {
  // The workflow knowledge helpers require the runtime context object. Keeping
  // this local avoids depending on repository-internal types in the sample.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
  emit?: (event: PiAgentSessionEvent) => void;
  onPendingApproval?: (error: steamharness.HarnessError) => void;
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

type JsonSchema = Record<string, unknown>;

export const KNOWLEDGE_DOCUMENTS_TOOL_NAME = "knowledge_documents";

// Pi Agent exposes the same PersistentValue-backed knowledge_documents tool
// as the OpenAI and Claude agent samples.
export function createKnowledgeDocumentsTool(input: KnowledgeDocumentsToolContext): ToolDefinition {
  return {
    name: KNOWLEDGE_DOCUMENTS_TOOL_NAME,
    label: "Knowledge Documents",
    description: [
      "Manage PersistentValue-backed project markdown knowledge documents.",
      "Use action=list to see summaries, get to read one document, create/edit/delete to change documents, search to find matching markdown lines, and read_lines for a 1-based inclusive line range.",
      "Before invoking this tool, tell the user in normal assistant text which knowledge document operation you are about to perform and why.",
    ].join(" "),
    promptSnippet: "Manage project knowledge documents with list, get, create, edit, delete, search, and read_lines actions.",
    promptGuidelines: [
      "Before calling knowledge_documents, explain the operation and purpose in normal assistant text.",
      "Use includeMarkdown=false or maxMarkdownLength for large documents unless the user needs the full markdown.",
    ],
    parameters: createKnowledgeDocumentsSchema() as never,
    async execute(_toolCallId, rawParams) {
      let args: KnowledgeDocumentsToolArgs | undefined;
      try {
        args = normalizeKnowledgeDocumentsArgs(rawParams);
        // routes the Pi custom tool through the shared tool approval
        // gate before touching PersistentValue-backed knowledge documents.
        const decision = await steamharness.createToolApprovalGate().approve({
          name: KNOWLEDGE_DOCUMENTS_TOOL_NAME,
          label: "Knowledge Documents",
          description: "Manage PersistentValue-backed project markdown knowledge documents.",
          arguments: args,
        }, input.context);
        if (decision.requestId !== undefined) {
          emitToolApprovalDecision(input.emit, {
            toolName: KNOWLEDGE_DOCUMENTS_TOOL_NAME,
            label: "Knowledge Documents",
            status: "approved",
            requestId: decision.requestId,
            arguments: args,
            values: decision.values,
          });
        }
        const result = await runKnowledgeDocumentsAction(input.context, args);
        return createToolResult(result);
      } catch (error) {
        if (
          error instanceof steamharness.HarnessError &&
          (error.type === "user_input_required" || error.type === "tool_permission_denied")
        ) {
          if (error.type === "user_input_required") {
            input.onPendingApproval?.(error);
          } else {
            emitToolApprovalDecision(input.emit, {
              toolName: KNOWLEDGE_DOCUMENTS_TOOL_NAME,
              label: "Knowledge Documents",
              status: "rejected",
              requestId: readApprovalRequestId(error),
              arguments: args ?? rawParams,
              values: readApprovalValues(error),
              message: error.message,
            });
          }
          throw error;
        }
        return createToolResult(formatToolError(error, readActionForError(rawParams)));
      }
    },
  };
}

function emitToolApprovalDecision(
  emit: KnowledgeDocumentsToolContext["emit"],
  input: Parameters<typeof createToolApprovalDecisionChunks>[0],
): void {
  for (const chunk of createToolApprovalDecisionChunks(input)) {
    emit?.({ type: "output_chunk", chunk });
  }
}

function readApprovalRequestId(error: steamharness.HarnessError): string | undefined {
  const requestId = error.metadata?.["requestId"];
  if (typeof requestId === "string") {
    return requestId;
  }

  const request = error.metadata?.["request"];
  return isRecord(request) && typeof request.requestId === "string"
    ? request.requestId
    : undefined;
}

function readApprovalValues(error: steamharness.HarnessError): Record<string, unknown> | undefined {
  const values = error.metadata?.["values"];
  return isRecord(values) ? values : undefined;
}

async function runKnowledgeDocumentsAction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projectContext: any,
  args: KnowledgeDocumentsToolArgs,
) {
  switch (args.action) {
    case "list": {
      const documents = await steamharness.listKnowledgeDocuments(projectContext.storage.local);
      return {
        action: "list" as const,
        count: documents.length,
        documents,
      };
    }
    case "get": {
      const documentId = requireToolString(args.documentId, "documentId", args.action);
      const document = await steamharness.getKnowledgeDocument(projectContext.storage.local, documentId);
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
      const document = await steamharness.createKnowledgeDocument(projectContext.storage.local, {
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
      const document = await steamharness.editKnowledgeDocument(projectContext.storage.local, {
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
        ...(await steamharness.deleteKnowledgeDocument(
          projectContext.storage.local,
          requireToolString(args.documentId, "documentId", args.action),
        )),
      };
    }
    case "search": {
      return {
        action: "search" as const,
        ...(await steamharness.searchKnowledgeDocuments(projectContext.storage.local, {
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
        ...(await steamharness.readKnowledgeDocumentLines(projectContext.storage.local, {
          documentId: requireToolString(args.documentId, "documentId", args.action),
          startLine: requireToolNumber(args.startLine, "startLine", args.action),
          endLine: requireToolNumber(args.endLine, "endLine", args.action),
        })),
      };
    }
    default:
      throw new steamharness.HarnessError({
        type: "input_validation",
        message: `Unsupported knowledge_documents action: ${String(args.action)}.`,
        nodeName: "pi-agent-output",
        metadata: { action: String(args.action) },
      });
  }
}

function createToolResult(result: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result),
      },
    ],
    details: result,
  };
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

function createKnowledgeDocumentsSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "create", "edit", "delete", "search", "read_lines"],
        description: "Knowledge document operation to perform.",
      },
      documentId: { type: "string", minLength: 1, maxLength: 200 },
      title: { type: "string", minLength: 1, maxLength: 200 },
      markdown: { type: "string", maxLength: 200000 },
      query: { type: "string", minLength: 1, maxLength: 500 },
      beforeLines: { type: "number", minimum: 0, maximum: 50 },
      afterLines: { type: "number", minimum: 0, maximum: 50 },
      pageSize: { type: "number", minimum: 1, maximum: 1000 },
      cursor: { type: "string", minLength: 1, maxLength: 80 },
      startLine: { type: "number", minimum: 1 },
      endLine: { type: "number", minimum: 1 },
      includeMarkdown: { type: "boolean" },
      maxMarkdownLength: { type: "number", minimum: 100, maximum: 20000 },
    },
    required: ["action"],
    additionalProperties: false,
  };
}

function normalizeKnowledgeDocumentsArgs(value: unknown): KnowledgeDocumentsToolArgs {
  if (!isRecord(value)) {
    return { action: "list" };
  }
  return {
    action: normalizeKnowledgeDocumentsAction(value.action),
    documentId: normalizeOptionalString(value.documentId),
    title: normalizeOptionalString(value.title),
    markdown: normalizeOptionalString(value.markdown),
    query: normalizeOptionalString(value.query),
    beforeLines: normalizeOptionalNumber(value.beforeLines),
    afterLines: normalizeOptionalNumber(value.afterLines),
    pageSize: normalizeOptionalNumber(value.pageSize),
    cursor: normalizeOptionalString(value.cursor),
    startLine: normalizeOptionalNumber(value.startLine),
    endLine: normalizeOptionalNumber(value.endLine),
    includeMarkdown: typeof value.includeMarkdown === "boolean" ? value.includeMarkdown : undefined,
    maxMarkdownLength: normalizeOptionalNumber(value.maxMarkdownLength),
  };
}

function normalizeKnowledgeDocumentsAction(value: unknown): KnowledgeDocumentsAction {
  if (
    value === "list" ||
    value === "get" ||
    value === "create" ||
    value === "edit" ||
    value === "delete" ||
    value === "search" ||
    value === "read_lines"
  ) {
    return value;
  }

  throw new steamharness.HarnessError({
    type: "input_validation",
    message: `Unsupported knowledge_documents action: ${String(value)}.`,
    nodeName: "pi-agent-output",
    metadata: { action: String(value) },
  });
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
    nodeName: "pi-agent-output",
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
    nodeName: "pi-agent-output",
    metadata: { action, field },
  });
}

function formatToolError(error: unknown, action: KnowledgeDocumentsAction) {
  if (error instanceof steamharness.HarnessError) {
    return {
      action,
      errCode: 1,
      errMessage: error.message,
      metadata: error.metadata ?? null,
    };
  }

  return {
    action,
    errCode: 1,
    errMessage: error instanceof Error ? error.message : String(error),
  };
}

function readActionForError(value: unknown): KnowledgeDocumentsAction {
  if (isRecord(value) && isKnowledgeDocumentsAction(value.action)) {
    return value.action;
  }
  return "list";
}

function isKnowledgeDocumentsAction(value: unknown): value is KnowledgeDocumentsAction {
  return value === "list" ||
    value === "get" ||
    value === "create" ||
    value === "edit" ||
    value === "delete" ||
    value === "search" ||
    value === "read_lines";
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
