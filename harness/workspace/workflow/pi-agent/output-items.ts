import type { PiAgentToolEvent, OutputItem } from "./interface";

export interface OutputItemChunk {
  type: "output_item_start" | "output_item_delta" | "output_item_end";
  item?: OutputItem;
  itemId?: string;
  delta?: unknown;
}

export function createAnswerItemStartChunk(itemId: string): OutputItemChunk {
  return {
    type: "output_item_start",
    item: {
      id: itemId,
      title: "Output",
      content: "",
      contentType: "markdown",
      collapsed: false,
      // AI answers intentionally omit metadata/icon so shared UI renders them inline, not as output detail.
    },
  };
}

// Tool lifecycle events keep metadata so the UI renders them as output detail rows.
export function createToolStartChunk(event: PiAgentToolEvent): OutputItemChunk {
  return {
    type: "output_item_start",
    item: {
      id: createToolItemId(event.toolCallId),
      title: `${event.toolName} running`,
      content: {
        tool: event.toolName,
        args: event.args ?? {},
        status: "running",
      },
      contentType: "json",
      collapsed: true,
      iconPreset: "code",
      metadata: {
        kind: "pi-agent-tool",
        status: "running",
        toolName: event.toolName,
      },
    },
  };
}

export function createToolEndChunks(event: PiAgentToolEvent): OutputItemChunk[] {
  const itemId = createToolItemId(event.toolCallId);
  const status = event.isError ? "failed" : "success";
  return [
    {
      type: "output_item_delta",
      itemId,
      delta: {
        tool: event.toolName,
        result: event.result ?? event.partialResult ?? null,
        status,
      },
      item: {
        title: `${event.toolName} ${status}`,
        iconPreset: event.isError ? "error" : "success",
        metadata: {
          kind: "pi-agent-tool",
          status,
          toolName: event.toolName,
        },
      },
    },
    {
      type: "output_item_end",
      itemId,
    },
  ];
}

export function createToolApprovalDecisionChunks(input: {
  toolName: string;
  label?: string;
  status: "approved" | "rejected";
  requestId?: string;
  arguments?: unknown;
  values?: Record<string, unknown>;
  message?: string;
}): OutputItemChunk[] {
  const statusText = input.status === "approved" ? "已批准" : "已拒绝";
  const itemId = `pi-agent-tool-approval-${sanitizeIdPart(`${input.requestId ?? input.toolName}-${input.status}`)}`;
  const displayName = normalizeDisplayText(input.label) ?? input.toolName;
  return [
    {
      type: "output_item_start",
      item: {
        id: itemId,
        title: `工具权限审批 · ${displayName} · ${statusText}`,
        content: {
          tool: input.toolName,
          label: displayName,
          status: input.status,
          statusText,
          requestId: input.requestId,
          message: input.message,
          arguments: input.arguments,
          values: input.values,
        },
        contentType: "json",
        collapsed: false,
        iconPreset: input.status === "approved" ? "success" : "error",
        metadata: {
          kind: "pi-agent-tool-approval",
          status: input.status,
          toolName: input.toolName,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        },
      },
    },
    {
      type: "output_item_end",
      itemId,
    },
  ];
}

export function createToolItemId(toolCallId: string): string {
  return `pi-agent-tool-${sanitizeIdPart(toolCallId)}`;
}

function normalizeDisplayText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function sanitizeIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "unknown";
}
