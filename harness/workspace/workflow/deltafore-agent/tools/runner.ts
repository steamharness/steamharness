import type { AgentToolCall, AgentToolResult } from "../interface";
import {
  type DeltaforeApiConfig,
  findToolDefinition,
  runOpenApiTool,
} from "./openapi";

export async function runTool(
  config: DeltaforeApiConfig,
  toolCall: AgentToolCall,
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<AgentToolResult> {
  const startedAt = new Date();

  try {
    const definition = findToolDefinition(config, toolCall.toolName);
    const data = await runOpenApiTool(config, toolCall.toolName, toolCall.args, {
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });

    return createToolResult(
      toolCall,
      true,
      data,
      `${definition.toolName} returned HTTP ${data.status}; ${formatResponseSummary(data.responseSummary)}.`,
      startedAt,
    );
  } catch (error) {
    return createToolResult(
      toolCall,
      false,
      null,
      error instanceof Error ? error.message : String(error),
      startedAt,
    );
  }
}

function createToolResult(
  toolCall: AgentToolCall,
  ok: boolean,
  data: unknown,
  summary: string,
  startedAt: Date,
): AgentToolResult {
  const endedAt = new Date();

  return {
    toolName: toolCall.toolName,
    args: toolCall.args,
    ok,
    data,
    summary,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
  };
}

function formatResponseSummary(summary: { kind: string; count?: number; total?: number; keys?: string[] }): string {
  if (summary.kind === "array") {
    return `array count=${summary.count ?? 0}`;
  }

  if (summary.kind === "object") {
    const count = summary.count === undefined ? "" : ` rows=${summary.count}`;
    const total = summary.total === undefined ? "" : ` total=${summary.total}`;
    const keys = summary.keys?.length ? ` keys=${summary.keys.join(",")}` : "";
    return `object${count}${total}${keys}`;
  }

  return summary.kind;
}
