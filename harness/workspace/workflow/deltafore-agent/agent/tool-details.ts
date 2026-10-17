import type {
  AgentToolCall,
  AgentToolResult,
} from "../interface";
import { formatAttributeLabel } from "../tools/attribute-labels";
import type { AgentFacts, DeltaforeToolResultData, ResponseSummary } from "../tools/openapi";
import { isRecord } from "../tools/values";

export function createToolRunningTitle(toolCall: AgentToolCall, round: number): string {
  return `工具调用中：第 ${round} 轮 ${formatToolCall(toolCall)}`;
}

export function createToolRunningContent(
  toolCall: AgentToolCall,
  round: number,
): Record<string, unknown> {
  return {
    status: "running",
    round,
    tool: toolCall.toolName,
    args: toolCall.args,
    summary: "工具正在执行，等待数据返回。",
  };
}

export function createToolResultTitle(result: AgentToolResult): string {
  if (!result.ok) {
    return `工具调用失败：${formatToolCallFromResult(result)}`;
  }

  return `工具调用完成：${formatToolCallFromResult(result)}`;
}

export function createToolResultIcon(result: AgentToolResult): string {
  const summary = summarizeToolData(result.data);

  if (!result.ok) {
    return "[x]";
  }

  if (summary.kind === "items" && summary.count === 0) {
    return "[!]";
  }

  return "[ok]";
}

export function createToolResultContent(result: AgentToolResult): Record<string, unknown> {
  const resultSummary = summarizeToolData(result.data);

  return {
    status: result.ok ? "success" : "failed",
    tool: result.toolName,
    ok: result.ok,
    summary: result.summary,
    overview: createDataOverview(resultSummary),
    highlights: resultSummary.highlights,
    args: result.args,
    data: createDisplayData(result.data),
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs,
  };
}

export function createObservation(result: AgentToolResult): string {
  const data = isRecord(result.data) && isHttpToolResultData(result.data)
    ? result.data
    : undefined;

  if (!result.ok) {
    return `Action ${formatToolCallFromResult(result)} 执行失败：${result.summary}`;
  }

  if (data === undefined) {
    return `Action ${formatToolCallFromResult(result)} 已返回：${result.summary}`;
  }

  const facts = data.agentFacts;
  const parts = [
    `HTTP ${data.status} ${data.method} ${data.path}`,
    formatResponseSummary(data.responseSummary),
    formatAgentFactsSummary(facts),
  ].filter((part): part is string => part !== undefined && part.trim() !== "");

  if (facts.page?.hasMore === true && facts.nextPageArgs !== undefined) {
    parts.push(`还有下一页，可用 nextPageArgs=${JSON.stringify(facts.nextPageArgs)} 继续同一工具。`);
  }

  return parts.join("；");
}

function createDisplayData(data: unknown): unknown {
  if (!isRecord(data) || !isHttpToolResultData(data)) {
    return data;
  }

  return {
    status: data.status,
    statusText: data.statusText,
    url: data.url,
    method: data.method,
    path: data.path,
    params: data.params,
    responseSummary: data.responseSummary,
    previewTruncated: data.previewTruncated,
    truncated: data.truncated,
    agentFacts: data.agentFacts,
  };
}

interface ToolDataSummary {
  kind: "items" | "detail" | "http" | "empty" | "value";
  count?: number;
  name?: string;
  status?: number;
  method?: string;
  path?: string;
  responseSummary?: ResponseSummary;
  agentFacts?: AgentFacts;
  highlights: string[];
}

function summarizeToolData(data: unknown): ToolDataSummary {
  if (Array.isArray(data)) {
    return {
      kind: "items",
      count: data.length,
      highlights: data.slice(0, 5).map(formatItemHighlight).filter((line): line is string => line !== undefined),
    };
  }

  if (isRecord(data)) {
    if (isHttpToolResultData(data)) {
      return {
        kind: "http",
        status: data.status,
        method: data.method,
        path: data.path,
        responseSummary: data.responseSummary,
        agentFacts: data.agentFacts,
        highlights: formatHttpHighlights(data),
      };
    }

    return {
      kind: "detail",
      name: readDisplayText(data.objectName),
      highlights: [formatItemHighlight(data)].filter((line): line is string => line !== undefined),
    };
  }

  if (data === null || data === undefined) {
    return { kind: "empty", highlights: ["没有返回可用装备数据。"] };
  }

  return { kind: "value", highlights: [`返回值：${String(data)}`] };
}

function createDataOverview(summary: ToolDataSummary): string {
  if (summary.kind === "items") {
    return summary.count === 0 ? "没有匹配项。" : `返回 ${summary.count} 条候选装备。`;
  }

  if (summary.kind === "detail") {
    return summary.name ? summary.name : "返回 1 条装备详情。";
  }

  if (summary.kind === "http") {
    const parts = [
      summary.method,
      summary.path,
      summary.status === undefined ? undefined : `HTTP ${summary.status}`,
      formatResponseSummary(summary.responseSummary),
    ].filter((part): part is string => part !== undefined);
    return parts.join(" / ");
  }

  if (summary.kind === "empty") {
    return "没有返回装备数据。";
  }

  return "返回非结构化结果。";
}

function isHttpToolResultData(value: Record<string, unknown>): value is DeltaforeToolResultData {
  return typeof value.status === "number" &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    isRecord(value.responseSummary);
}

function formatHttpHighlights(data: DeltaforeToolResultData): string[] {
  const rows = data.agentFacts?.rows ?? [];
  const highlights = [
    `请求：${data.method} ${data.path}，状态 ${data.status}`,
    formatResponseSummary(data.responseSummary),
    formatAgentFactsSummary(data.agentFacts),
    ...rows.slice(0, 4).map(formatApiRowHighlight).filter((line): line is string => line !== undefined),
  ];

  return highlights.filter((line): line is string => line !== undefined).slice(0, 6);
}

function formatAgentFactsSummary(value: AgentFacts | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parts = [
    value.rowCount === undefined ? undefined : `推理可用行 ${value.rowCount} 条`,
    value.page?.hasMore === true && value.nextPageArgs ? `还有下一页 offset=${String(value.nextPageArgs.offset)}` : undefined,
    value.truncated ? "推理事实已按上限裁剪" : undefined,
  ].filter((part): part is string => part !== undefined);

  return parts.length === 0 ? undefined : parts.join("，");
}

function formatApiRowHighlight(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = readDisplayText(value.objectName) ?? readDisplayText(value.name) ?? readDisplayText(value.gameName);
  const id = typeof value.objectID === "string" || typeof value.objectID === "number" ? value.objectID : value.objectId;
  const price = typeof value.avgPrice === "number" ? `均价 ${value.avgPrice}` : undefined;
  const grade = typeof value.grade === "number" ? `等级 ${value.grade}` : undefined;
  const stats = formatStats(value);
  const parts = [
    name ?? "返回项",
    id === undefined ? undefined : `ID ${String(id)}`,
    grade,
    price,
    stats,
  ].filter((part): part is string => part !== undefined);

  return parts.join("；");
}

function formatResponseSummary(summary: ResponseSummary | undefined): string | undefined {
  if (summary === undefined) {
    return undefined;
  }

  if (summary.kind === "array") {
    return `数组结果 ${summary.count ?? 0} 条`;
  }

  if (summary.kind === "object") {
    const parts = [
      summary.count === undefined ? undefined : `${summary.count} 条数据`,
      summary.total === undefined ? undefined : `总数 ${summary.total}`,
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? "对象结果" : parts.join("，");
  }

  if (summary.kind === "empty") {
    return "空响应";
  }

  return "基础值响应";
}

function formatItemHighlight(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = readDisplayText(value.objectName) ?? readDisplayText(value.shortName) ?? "未命名装备";
  const id = typeof value.objectID === "string" || typeof value.objectID === "number" ? value.objectID : undefined;
  const price = typeof value.avgPrice === "number" ? `均价 ${value.avgPrice}` : undefined;
  const parts = [
    name,
    id === undefined ? undefined : `ID ${String(id)}`,
    price,
  ].filter((part): part is string => part !== undefined);

  return parts.join("；");
}

function formatToolCall(toolCall: AgentToolCall): string {
  return `${toolCall.toolName}(${formatToolArgs(toolCall.args)})`;
}

function formatToolCallFromResult(result: AgentToolResult): string {
  return `${result.toolName}(${formatToolArgs(result.args)})`;
}

function formatToolArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([key, value]) => `${key}: ${formatArgValue(value)}`);
  return parts.join(", ");
}

function formatArgValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return String(value);
}

function formatStats(value: Record<string, unknown>): string | undefined {
  const statNames = new Set(["controlSpeed", "hipShot", "recoil", "controlStable", "fireSpeed", "protectLevel"]);
  const parts: string[] = [];

  for (const [key, raw] of Object.entries(value)) {
    if ((typeof raw === "number" || typeof raw === "string") && statNames.has(key)) {
      parts.push(`${formatAttributeLabel(key)}: ${String(raw)}`);
    }
  }

  return parts.length === 0 ? undefined : parts.slice(0, 4).join("，");
}

function readDisplayText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const text = value.trim();
  return text === "" ? undefined : text;
}
