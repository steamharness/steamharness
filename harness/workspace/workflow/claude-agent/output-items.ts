export type ClaudeAgentOutputItemPhase = "started" | "updated" | "completed";

export type ClaudeAgentOutputItemChunk =
  | {
      type: "output_item_start";
      item: {
        id?: string;
        title: string;
        content: unknown;
        icon?: string;
        iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
        contentType?: "markdown" | "text" | "json";
        collapsed?: boolean;
        metadata?: Record<string, unknown>;
      };
    }
  | {
      type: "output_item_delta";
      itemId: string;
      delta: unknown;
      item?: {
        title?: string;
        icon?: string;
        iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
        contentType?: "markdown" | "text" | "json";
        collapsed?: boolean;
        metadata?: Record<string, unknown>;
      };
    }
  | { type: "output_item_end"; itemId: string };

interface KnowledgeToolArgsShape {
  action?: string;
  documentId?: string;
  title?: string;
}

type ToolIconPreset =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "note"
  | "code"
  | "list"
  | "quote"
  | "none";

interface KnowledgeActionDescriptor {
  label: string;
  iconPreset: ToolIconPreset;
  // Whether this action targets an existing document; controls whether the
  // document id / title should appear in the title suffix.
  targetsDocument: boolean;
}

const KNOWLEDGE_ACTION_LABELS: Record<string, KnowledgeActionDescriptor> = {
  list: { label: "列出文档", iconPreset: "list", targetsDocument: false },
  get: { label: "读取文档", iconPreset: "info", targetsDocument: true },
  create: { label: "创建文档", iconPreset: "success", targetsDocument: false },
  edit: { label: "编辑文档", iconPreset: "note", targetsDocument: true },
  delete: { label: "删除文档", iconPreset: "warning", targetsDocument: true },
  search: { label: "搜索文档", iconPreset: "code", targetsDocument: false },
  read_lines: { label: "读取行范围", iconPreset: "list", targetsDocument: true },
};

const FALLBACK_KNOWLEDGE_ACTION: KnowledgeActionDescriptor = {
  label: "调用知识文档",
  iconPreset: "code",
  targetsDocument: false,
};

export function createAssistantTextChunks(
  itemId: string,
  text: string,
  options: { started: boolean },
): ClaudeAgentOutputItemChunk[] {
  const chunks: ClaudeAgentOutputItemChunk[] = [];

  if (!options.started) {
    if (text === "") return [];
    chunks.push({
      type: "output_item_start",
      item: {
        id: itemId,
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });
  }

  if (text !== "") {
    chunks.push({ type: "output_item_delta", itemId, delta: text });
  }

  return chunks;
}

export function createToolUseChunks(
  block: { name: string; input: unknown },
  round: number,
): ClaudeAgentOutputItemChunk[] {
  const itemId = `claude-agent-tool-${round}`;
  const friendlyName = friendlyToolName(block.name);
  const summary = summarizeToolInput(friendlyName, block.input);
  const title = buildToolTitle(friendlyName, summary);
  return [
    {
      type: "output_item_start",
      item: {
        id: itemId,
        title,
        iconPreset: summary.iconPreset,
        content: formatToolStartMarkdown({
          name: friendlyName,
          input: block.input,
          actionLabel: summary.actionLabel,
          target: summary.target,
        }),
        contentType: "markdown",
        collapsed: true,
        metadata: {
          kind: "claude-agent-tool",
          tool: friendlyName,
          status: "running",
          ...(summary.metadata ?? {}),
        },
      },
    },
  ];
}

export function createToolResultChunks(
  toolItemId: string,
  status: "success" | "failed",
  result?: unknown,
  options: {
    startInfo?: {
      friendlyName: string;
      summary: ToolInputSummary;
    };
    titleOverride?: string;
    iconPresetOverride?: ToolIconPreset;
  } = {},
): ClaudeAgentOutputItemChunk[] {
  const resultSummary = summarizeToolResult(result);
  const finalSummary = options.startInfo
    ? mergeSummaryWithResult(options.startInfo.summary, resultSummary)
    : resultSummary;
  const title = options.startInfo
    ? buildToolTitle(options.startInfo.friendlyName, finalSummary)
    : undefined;
  const iconPreset = options.iconPresetOverride
    ?? finalSummary.iconPreset
    ?? (status === "success" ? "success" : "error");
  const itemPatch: {
    iconPreset: ToolIconPreset;
    metadata: Record<string, unknown>;
    title?: string;
  } = {
    iconPreset,
    metadata: {
      status,
      ...(finalSummary.metadata ?? {}),
    },
  };
  if (title && options.startInfo && title !== buildToolTitle(options.startInfo.friendlyName, options.startInfo.summary)) {
    itemPatch.title = title;
  } else if (options.titleOverride) {
    itemPatch.title = options.titleOverride;
  }
  return [
    {
      type: "output_item_delta",
      itemId: toolItemId,
      delta: formatToolFinishMarkdown({ status, result, summary: finalSummary }),
      item: itemPatch,
    },
    { type: "output_item_end", itemId: toolItemId },
  ];
}

export function createToolApprovalDecisionChunks(
  input: {
    rawToolName: string;
    label?: string;
    status: "approved" | "rejected";
    requestId?: string;
    reason?: string;
    message?: string;
    arguments?: unknown;
    values?: Record<string, unknown>;
  },
  round: number,
): ClaudeAgentOutputItemChunk[] {
  const friendlyName = friendlyToolName(input.rawToolName);
  const displayName = normalizeDisplayText(input.label) ?? friendlyName;
  const statusText = input.status === "approved" ? "已批准" : "已拒绝";
  const itemId = `claude-agent-tool-approval-${round}`;

  return [
    {
      type: "output_item_start",
      item: {
        id: itemId,
        title: `工具权限审批 · ${displayName} · ${statusText}`,
        iconPreset: input.status === "approved" ? "success" : "error",
        content: formatToolApprovalDecisionMarkdown({
          ...input,
          friendlyName,
          displayName,
          statusText,
        }),
        contentType: "markdown",
        collapsed: false,
        metadata: {
          kind: "claude-agent-tool-approval",
          tool: friendlyName,
          rawToolName: input.rawToolName,
          status: input.status,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        },
      },
    },
    { type: "output_item_end", itemId },
  ];
}

function mergeSummaryWithResult(
  start: ToolInputSummary,
  result: ToolResultSummary,
): ToolInputSummary {
  const actionLabel = start.actionLabel ?? deriveActionLabelFromResult(result);
  const target = start.target ?? deriveTargetFromResult(result);
  const iconPreset = start.iconPreset !== "code"
    ? start.iconPreset
    : result.iconPreset ?? "code";
  const metadata: Record<string, unknown> = { ...(start.metadata ?? {}) };
  for (const [key, value] of Object.entries(result.metadata ?? {})) {
    if (metadata[key] === undefined) {
      metadata[key] = value;
    }
  }
  if (actionLabel && metadata.actionLabel === undefined) {
    metadata.actionLabel = actionLabel;
  }
  if (target && metadata.target === undefined) {
    metadata.target = target;
  }
  return {
    actionLabel,
    target,
    iconPreset,
    headline: buildMergedHeadline(actionLabel, target, result, metadata),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function buildMergedHeadline(
  actionLabel: string | undefined,
  target: string | undefined,
  result: ToolResultSummary,
  metadata: Record<string, unknown>,
): string | undefined {
  // Prefer the headline the result summary already built (it includes
  // counts / totalMatches / deleted / document title out of the box).
  if (result.headline) {
    return result.headline;
  }
  if (!actionLabel && !target) {
    return undefined;
  }
  const segments: string[] = [];
  if (actionLabel) segments.push(actionLabel);
  if (target) segments.push(target);
  if (typeof metadata.count === "number") {
    segments.push(`${metadata.count} 项`);
  } else if (typeof metadata.totalMatches === "number") {
    segments.push(`${metadata.totalMatches} 处匹配`);
  }
  return segments.join(" · ");
}

function deriveActionLabelFromResult(result: ToolResultSummary): string | undefined {
  if (typeof result.metadata?.action === "string") {
    return typeof result.metadata.actionLabel === "string"
      ? result.metadata.actionLabel
      : undefined;
  }
  return undefined;
}

function deriveTargetFromResult(result: ToolResultSummary): string | undefined {
  if (typeof result.metadata?.documentTitle === "string") {
    return `「${result.metadata.documentTitle}」`;
  }
  if (typeof result.metadata?.documentId === "string") {
    return result.metadata.documentId;
  }
  return undefined;
}

interface ToolResultSummary {
  headline: string | undefined;
  iconPreset: ToolIconPreset | undefined;
  metadata: Record<string, unknown> | undefined;
}

function summarizeToolResult(result: unknown): ToolResultSummary {
  if (!isPlainObject(result)) {
    return { headline: undefined, iconPreset: undefined, metadata: undefined };
  }
  const metadata: Record<string, unknown> = {};
  let headline: string | undefined;
  let iconPreset: ToolIconPreset | undefined;
  const action = typeof result.action === "string" ? result.action : undefined;
  if (action) {
    const descriptor = KNOWLEDGE_ACTION_LABELS[action] ?? FALLBACK_KNOWLEDGE_ACTION;
    metadata.action = action;
    metadata.actionLabel = descriptor.label;
    metadata.iconPreset = descriptor.iconPreset;
    iconPreset = descriptor.iconPreset;
    headline = descriptor.label;
  }
  if (typeof result.count === "number") {
    metadata.count = result.count;
    headline = headline ? `${headline} · ${result.count} 项` : `${result.count} 项`;
  } else if (typeof result.totalMatches === "number") {
    metadata.totalMatches = result.totalMatches;
    headline = headline
      ? `${headline} · ${result.totalMatches} 处匹配`
      : `${result.totalMatches} 处匹配`;
  } else if (result.deleted === true) {
    metadata.deleted = true;
    headline = headline ? `${headline} · 已删除` : "已删除";
  } else if (isPlainObject(result.document)) {
    const doc = result.document as { id?: unknown; title?: unknown };
    if (typeof doc.id === "string") metadata.documentId = doc.id;
    if (typeof doc.title === "string") metadata.documentTitle = doc.title;
    if (typeof doc.title === "string") {
      headline = headline ? `${headline} · 「${doc.title}」` : `「${doc.title}」`;
    }
  }
  return {
    headline,
    iconPreset,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

// The Claude Agent SDK formats SDK MCP tool names as
// `mcp__<server-name>__<tool-name>`; users only need to see the tool name, so
// strip the prefix for display purposes.
export function friendlyToolName(rawName: string): string {
  const mcpMatch = rawName.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  if (mcpMatch?.[1]) {
    return mcpMatch[1];
  }
  return rawName;
}

interface ToolInputSummary {
  actionLabel: string | undefined;
  target: string | undefined;
  iconPreset: ToolIconPreset;
  // When set, overrides the default `**状态**：…` formatting in the finish
  // markdown so we can show e.g. `**结果**：创建文档 · 「标题」 · 完成`.
  headline: string | undefined;
  metadata: Record<string, unknown> | undefined;
}

function summarizeToolInput(friendlyName: string, input: unknown): ToolInputSummary {
  if (friendlyName === "knowledge_documents" && isPlainObject(input)) {
    const args = input as KnowledgeToolArgsShape;
    const action = typeof args.action === "string" ? args.action : undefined;
    const descriptor = action
      ? (KNOWLEDGE_ACTION_LABELS[action] ?? FALLBACK_KNOWLEDGE_ACTION)
      : undefined;
    const documentId = typeof args.documentId === "string" ? args.documentId.trim() : "";
    const documentTitle = typeof args.title === "string" ? args.title.trim() : "";
    const target = descriptor
      ? pickKnowledgeTarget(descriptor, documentId, documentTitle)
      : undefined;
    const metadata: Record<string, unknown> = {};
    if (action) metadata.action = action;
    if (descriptor) {
      metadata.iconPreset = descriptor.iconPreset;
      metadata.actionLabel = descriptor.label;
    }
    if (documentId) metadata.documentId = documentId;
    if (documentTitle) metadata.title = documentTitle;
    if (target) metadata.target = target;
    return {
      actionLabel: descriptor?.label,
      target,
      iconPreset: descriptor?.iconPreset ?? "code",
      headline: undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }
  return {
    actionLabel: undefined,
    target: undefined,
    iconPreset: "code",
    headline: undefined,
    metadata: undefined,
  };
}

function pickKnowledgeTarget(
  descriptor: KnowledgeActionDescriptor,
  documentId: string,
  documentTitle: string,
): string | undefined {
  if (!descriptor.targetsDocument) {
    // Create / list / search surface the document title when known — the user
    // wants to see *what* is being made or scanned, not an empty suffix.
    if (documentTitle) return `「${documentTitle}」`;
    return undefined;
  }
  if (documentId && documentTitle) return `「${documentTitle}」(${documentId})`;
  if (documentId) return documentId;
  if (documentTitle) return `「${documentTitle}」`;
  return undefined;
}

function buildToolTitle(friendlyName: string, summary: ToolInputSummary): string {
  // When we already have a richer headline (e.g. from a result summary that
  // includes counts / totalMatches), use it as-is so the title carries the
  // additional context.
  if (summary.headline) {
    return `${friendlyName} · ${summary.headline}`;
  }
  const segments: string[] = [friendlyName];
  if (summary.actionLabel) segments.push(summary.actionLabel);
  if (summary.target) segments.push(summary.target);
  return segments.join(" · ");
}

interface ToolStartInput {
  name: string;
  input: unknown;
  actionLabel: string | undefined;
  target: string | undefined;
}

function formatToolStartMarkdown(input: ToolStartInput): string {
  const lines: string[] = [];
  lines.push(`**工具调用** \`${input.name}\``);
  if (input.actionLabel) {
    lines.push("");
    lines.push(`动作：${input.actionLabel}`);
  }
  if (input.target) {
    lines.push("");
    lines.push(`目标：${input.target}`);
  }
  if (!isEmptyObject(input.input)) {
    lines.push("");
    lines.push("**参数**");
    lines.push(formatMarkdownValue(input.input));
  }
  return lines.join("\n");
}

interface ToolFinishInput {
  status: "success" | "failed";
  result: unknown;
  summary: ToolResultSummary;
}

function formatToolFinishMarkdown(input: ToolFinishInput): string {
  const statusText = input.status === "success" ? "完成" : "失败";
  const headline = input.summary.headline;
  const lines: string[] = [
    "",
    headline
      ? `**结果**：${headline} · ${statusText}`
      : `**状态**：${statusText}`,
  ];
  if (!isEmptyValue(input.result)) {
    lines.push("");
    lines.push("**详情**");
    lines.push(formatMarkdownValue(redactKnowledgeResult(input.result)));
  }
  return lines.join("\n");
}

function formatToolApprovalDecisionMarkdown(input: {
  friendlyName: string;
  displayName: string;
  status: "approved" | "rejected";
  statusText: string;
  requestId?: string;
  reason?: string;
  message?: string;
  arguments?: unknown;
  values?: Record<string, unknown>;
}): string {
  const lines: string[] = [
    `**工具权限审批** \`${input.friendlyName}\``,
    "",
    `结果：${input.statusText}`,
  ];
  if (input.displayName !== input.friendlyName) {
    lines.push("");
    lines.push(`工具：${input.displayName}`);
  }
  if (input.reason) {
    lines.push("");
    lines.push(`原因：${input.reason}`);
  }
  if (input.message) {
    lines.push("");
    lines.push(`说明：${input.message}`);
  }
  if (input.requestId) {
    lines.push("");
    lines.push(`请求：\`${input.requestId}\``);
  }
  if (!isEmptyValue(input.arguments)) {
    lines.push("");
    lines.push("**参数**");
    lines.push(formatMarkdownValue(input.arguments));
  }
  if (!isEmptyValue(input.values)) {
    lines.push("");
    lines.push("**审批值**");
    lines.push(formatMarkdownValue(input.values));
  }
  return lines.join("\n");
}

function redactKnowledgeResult(result: unknown): unknown {
  // Result deltas may carry the full tool response payload. For the
  // knowledge_documents tool, callers don't need the whole document body in
  // the chat-side summary; the persistent item and conversation messages
  // already capture the full content. We drop a few large fields here so
  // the chat output item stays scannable.
  if (!isPlainObject(result)) {
    return result;
  }
  const candidate = result as { document?: unknown; matches?: unknown; lines?: unknown };
  if (isPlainObject(candidate.document)) {
    const { markdown: _markdown, ...rest } = candidate.document as Record<string, unknown>;
    return { ...result, document: rest };
  }
  return result;
}

function normalizeDisplayText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isEmptyObject(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).length === 0;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatMarkdownValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.length > 2000 ? `${value.slice(0, 2000)}\n...` : value;
    return trimmed;
  }
  const json = safeJsonStringify(value);
  const trimmed = json.length > 4000 ? `${json.slice(0, 4000)}\n...` : json;
  return ["```json", trimmed, "```"].join("\n");
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== "object" || item === null) {
      return item;
    }
    if (seen.has(item)) {
      return "[Circular]";
    }
    seen.add(item);
    return item;
  }, 2);
}

export interface ToolDisplayStart {
  friendlyName: string;
  summary: ToolInputSummary;
}

export function summarizeToolInputForDisplay(
  rawToolName: string,
  input: unknown,
): ToolDisplayStart {
  const friendlyName = friendlyToolName(rawToolName);
  return { friendlyName, summary: summarizeToolInput(friendlyName, input) };
}
