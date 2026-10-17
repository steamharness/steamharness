import type { WorkflowParamDefinition, WorkflowParamStatePatch } from "../types";

export function resolveParamDefinition(
  param: WorkflowParamDefinition,
  state: WorkflowParamStatePatch | undefined,
): WorkflowParamDefinition {
  if (state?.resolvedOptions === undefined || state.resolvedOptions === null) return param;
  return { ...param, options: state.resolvedOptions };
}

export function isMultiParam(param: WorkflowParamDefinition): boolean {
  return param.type !== "file" && (param.multiple === true || param.control === "checkboxes");
}

export function readMultiParamValues(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string | number | boolean => (
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean"
        ))
        .map((item) => String(item));
    }
  } catch {
    return [trimmed];
  }

  return [trimmed];
}

export function writeMultiParamValues(values: string[]): string {
  return values.length === 0 ? "" : JSON.stringify(values);
}
