import type {
  DefinitionEvent,
  ExecutionReport,
  OutputReport,
  StructureReport,
} from "./report";
import type { DefinedNode } from "./rules";

export interface ExecutionFormatOptions {
  includeDefinedNodes?: boolean;
  includeJson?: boolean;
}

export function formatProjectDefinitionEvent(
  event: DefinitionEvent,
): string {
  return [
    "Workflow Definition",
    `Workflow: ${event.projectName}`,
    "Loaded Nodes:",
    ...formatDefinedNodeLines(event.nodes),
  ].join("\n");
}

export function formatProjectStructureReport(
  report: StructureReport,
): string {
  return formatJson(report);
}

export function formatProjectResultOnly(
  report: ExecutionReport,
): string {
  return [
    "Workflow Result",
    `Workflow: ${report.projectName || "(missing)"}`,
    `Status: ${report.status}`,
    `Duration: ${formatDuration(report.durationMs)}`,
    "",
    "Result:",
    indent(formatProjectResult(report), 2),
  ].join("\n");
}

export function formatProjectExecutionReport(
  report: ExecutionReport,
  options: ExecutionFormatOptions = {},
): string {
  const includeDefinedNodes = options.includeDefinedNodes ?? true;
  const includeJson = options.includeJson ?? true;
  const lines = [
    "Workflow Execution",
    `Workflow: ${report.projectName || "(missing)"}`,
    `Status: ${report.status}`,
    `Duration: ${formatDuration(report.durationMs)}`,
    `Started: ${report.startedAt.toISOString()}`,
    `Ended: ${report.endedAt.toISOString()}`,
    "",
  ];

  if (includeDefinedNodes) {
    lines.push("Loaded Nodes:", ...formatDefinedNodeLines(report.definedNodes), "");
  }

  lines.push(
    "Executed Nodes:",
    ...formatExecutedNodeLines(report),
    "",
    "Output Node Results:",
    ...formatOutputLines(report.outputs),
    "",
    "Workflow Result:",
    indent(formatProjectResult(report), 2),
  );

  if (includeJson) {
    lines.push("", "JSON Report:", formatJson(report));
  }

  return lines.join("\n");
}

export function formatProjectExecutionJson(report: ExecutionReport): string {
  return formatJson(report);
}

function formatDefinedNodeLines(nodes: DefinedNode[]): string[] {
  if (nodes.length === 0) {
    return ["  (none)"];
  }

  return nodes.map((node) => {
    return `  ${node.order}. ${padRight(node.name, 12)} ${formatLocation(node.location)}`;
  });
}

function formatExecutedNodeLines(report: ExecutionReport): string[] {
  if (report.nodes.length === 0) {
    return ["  (none)"];
  }

  return report.nodes.map((node) => {
    const errorSuffix =
      node.error === undefined ? "" : ` error="${node.error.message}"`;

    return [
      `  ${node.order}.`,
      padRight(node.name, 12),
      padRight(node.status, 8),
      padRight(formatDuration(node.durationMs ?? 0), 8),
      node.kind,
      errorSuffix,
    ].join(" ").trimEnd();
  });
}

function formatOutputLines(outputs: OutputReport[]): string[] {
  if (outputs.length === 0) {
    return ["  (none)"];
  }

  return outputs.flatMap((output) => {
    return [
      `  ${output.order}. ${output.nodeName} node #${output.nodeOrder}`,
      indent(formatJson(output.output), 4),
    ];
  });
}

function formatProjectResult(report: ExecutionReport): string {
  if (report.result.ok) {
    return formatJson(report.result.data);
  }

  return formatJson(report.result.error);
}

function formatLocation(location: DefinedNode["location"]): string {
  return `${location.file}:${location.line}:${location.column}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, createSafeJsonReplacer(), 2);
}

function createSafeJsonReplacer(): (key: string, value: unknown) => unknown {
  const ancestors: object[] = [];

  return function replacer(this: unknown, _key, value) {
    if (typeof value === "bigint") {
      return `${value.toString()}n`;
    }

    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }

    if (typeof value === "symbol") {
      return value.toString();
    }

    if (typeof value === "object" && value !== null) {
      while (ancestors.length > 0 && ancestors.at(-1) !== this) {
        ancestors.pop();
      }

      if (ancestors.includes(value)) {
        return "[Circular]";
      }

      ancestors.push(value);
    }

    return value;
  };
}

function indent(value: string, spaces: number): string {
  const padding = " ".repeat(spaces);

  return value
    .split("\n")
    .map((line) => `${padding}${line}`)
    .join("\n");
}

function padRight(value: string, length: number): string {
  return value.padEnd(length, " ");
}
