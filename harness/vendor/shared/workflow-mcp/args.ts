import {
  isWorkflowMcpMultiParam,
  normalizeWorkflowMcpDefaultValue,
  McpInvalidParamsError,
} from "./schema";
import type {
  McpFileInputMode,
  McpFileResolver,
  McpManagedFileReference,
  McpParamDefinition,
} from "./types";

export async function workflowMcpInputToArgs(options: {
  projectId: string;
  entrypointId: string;
  params: readonly McpParamDefinition[] | undefined;
  input: Record<string, unknown>;
  fileInputMode: McpFileInputMode;
  resolveFiles?: McpFileResolver;
  signal: AbortSignal;
}): Promise<string[]> {
  const args: string[] = [];
  const positional: string[] = [];

  for (const param of options.params ?? []) {
    const hasInput = Object.prototype.hasOwnProperty.call(options.input, param.name);
    const value = hasInput
      ? options.input[param.name]
      : normalizeWorkflowMcpDefaultValue(param, options.fileInputMode);
    if (value === undefined) continue;

    if (param.type === "file") {
      if (!options.resolveFiles) {
        throw new McpInvalidParamsError(`File parameter "${param.name}" is not supported by this host.`);
      }
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0 && param.required !== true) continue;
      const refs = await options.resolveFiles(values, {
        projectId: options.projectId,
        entrypointId: options.entrypointId,
        param,
        signal: options.signal,
      });
      appendValue(param, serializeManagedFiles(refs), args, positional);
      continue;
    }

    if (param.type === "boolean" && !isWorkflowMcpMultiParam(param)) {
      appendBoolean(param, value, args);
      continue;
    }

    const serialized = isWorkflowMcpMultiParam(param)
      ? JSON.stringify(value)
      : String(value);
    appendValue(param, serialized, args, positional);
  }

  args.push(...positional);
  return args;
}

function appendBoolean(
  param: McpParamDefinition,
  value: unknown,
  args: string[],
): void {
  if (typeof value !== "boolean" || !param.flag) return;
  if (value) {
    args.push(param.flag);
    return;
  }
  if (param.defaultValue === "true") args.push(param.flag, "false");
}

function appendValue(
  param: McpParamDefinition,
  value: string,
  args: string[],
  positional: string[],
): void {
  if (param.type === "positional") {
    positional.push(value);
  } else if (param.flag) {
    args.push(param.flag, value);
  } else {
    args.push(value);
  }
}

function serializeManagedFiles(refs: McpManagedFileReference[]): string {
  if (refs.length === 0) {
    throw new McpInvalidParamsError("At least one managed file is required.");
  }
  return JSON.stringify(refs);
}
