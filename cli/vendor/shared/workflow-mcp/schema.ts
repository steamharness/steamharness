import { z } from "zod";
import type {
  McpFileInputMode,
  McpJsonSchema,
  McpParamDefinition,
} from "./types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}:\d{2}$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE_RANGE_PATTERN = /^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/;

export class McpInvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpInvalidParamsError";
  }
}

export function isWorkflowMcpMultiParam(param: McpParamDefinition): boolean {
  return param.multiple === true || param.control === "checkboxes";
}

export function canWorkflowParamsUseMcpFormElicitation(
  params: readonly McpParamDefinition[],
): boolean {
  return params.every((param) => {
    if (param.type === "file") return false;
    if (!isWorkflowMcpMultiParam(param)) return true;
    return (param.type === "string" || param.type === "positional") &&
      (param.options?.length ?? 0) > 0;
  });
}

export function workflowParamsToMcpInputSchema(
  params: readonly McpParamDefinition[] | undefined,
  fileInputMode: McpFileInputMode,
): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  for (const param of params ?? []) {
    let schema = createParamSchema(param, fileInputMode);
    if (param.required !== true) schema = schema.optional();
    shape[param.name] = schema;
  }
  return z.object(shape).strict();
}

export function workflowParamsToMcpJsonSchema(
  params: readonly McpParamDefinition[] | undefined,
  fileInputMode: McpFileInputMode,
): McpJsonSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const param of params ?? []) {
    properties[param.name] = createParamJsonSchema(param, fileInputMode);
    if (param.required === true) required.push(param.name);
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function workflowParamsToMcpElicitationSchema(
  params: readonly McpParamDefinition[],
  defaultValues: Record<string, unknown> | undefined,
): {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
} {
  if (params.some((param) => param.type === "file")) {
    throw new McpInvalidParamsError("File fields cannot be requested through MCP elicitation.");
  }

  const schema = workflowParamsToMcpJsonSchema(params, "local");
  const properties = Object.fromEntries(params.map((param) => {
    const name = param.name;
    const property = schema.properties[name] ?? {};
    const { pattern: _pattern, additionalProperties: _additionalProperties, ...allowed } = property;
    if (allowed.format === "time") delete allowed.format;
    const override = defaultValues?.[name];
    if (override !== undefined) {
      const normalized = normalizeWorkflowMcpValue(param, override, "local");
      if (normalized === undefined) delete allowed.default;
      else allowed.default = normalized;
    }
    return [name, allowed];
  }));

  return {
    type: "object",
    properties,
    ...(schema.required ? { required: schema.required } : {}),
  };
}

function createParamSchema(
  param: McpParamDefinition,
  fileInputMode: McpFileInputMode,
): z.ZodType {
  let schema: z.ZodType;
  if (param.type === "file") {
    schema = fileInputMode === "local"
      ? z.string().min(1)
      : z.object({ id: z.string().min(1) }).strict();
  } else if (param.type === "number") {
    schema = z.number().finite();
  } else if (param.type === "boolean") {
    schema = z.boolean();
  } else {
    schema = createStringParamSchema(param);
  }

  const optionValues = param.type === "file" ? [] : normalizeOptionValues(param);
  if (optionValues.length > 0) {
    schema = schema.refine((value) => optionValues.some((allowed) => Object.is(allowed, value)), {
      message: `Expected one of: ${optionValues.join(", ")}`,
    });
  }

  if (isWorkflowMcpMultiParam(param)) {
    schema = z.array(schema).min(param.required === true ? 1 : 0);
  }

  const description = param.description?.trim();
  if (description) schema = schema.describe(description);
  return schema;
}

function createStringParamSchema(param: McpParamDefinition): z.ZodType {
  let schema = z.string();
  if (param.required === true) schema = schema.min(1);
  switch (param.control) {
    case "date":
      return schema.regex(DATE_PATTERN, "Expected YYYY-MM-DD.");
    case "time":
      return schema.regex(TIME_PATTERN, "Expected HH:mm:ss.");
    case "datetime":
      return schema.regex(DATETIME_PATTERN, "Expected YYYY-MM-DDTHH:mm:ss.");
    case "date-range":
      return schema.regex(DATE_RANGE_PATTERN, "Expected YYYY-MM-DD/YYYY-MM-DD.");
    default:
      return schema;
  }
}

function createParamJsonSchema(
  param: McpParamDefinition,
  fileInputMode: McpFileInputMode,
): Record<string, unknown> {
  const title = param.title?.trim() || param.label?.trim() || param.name;
  const description = param.description?.trim();
  let schema: Record<string, unknown>;

  if (param.type === "file") {
    schema = fileInputMode === "local"
      ? { type: "string" }
      : {
          type: "object",
          properties: { id: { type: "string", minLength: 1 } },
          required: ["id"],
          additionalProperties: false,
        };
  } else if (param.type === "number") {
    schema = { type: "number" };
  } else if (param.type === "boolean") {
    schema = { type: "boolean" };
  } else {
    schema = { type: "string" };
    if (param.required === true) schema.minLength = 1;
    if (param.control === "date") Object.assign(schema, { format: "date", pattern: DATE_PATTERN.source });
    if (param.control === "time") schema.pattern = TIME_PATTERN.source;
    if (param.control === "datetime") schema.pattern = DATETIME_PATTERN.source;
    if (param.control === "date-range") schema.pattern = DATE_RANGE_PATTERN.source;
  }

  const optionValues = normalizeOptionValues(param);
  if (optionValues.length > 0) schema.enum = optionValues;

  const defaultValue = normalizeWorkflowMcpDefaultValue(param, fileInputMode);
  if (defaultValue !== undefined) schema.default = defaultValue;
  schema.title = title;
  if (description) schema.description = description;

  if (!isWorkflowMcpMultiParam(param)) return schema;
  const itemSchema = { ...schema };
  delete itemSchema.default;
  delete itemSchema.title;
  delete itemSchema.description;
  return {
    type: "array",
    title,
    ...(description ? { description } : {}),
    items: itemSchema,
    ...(param.required === true ? { minItems: 1 } : {}),
    ...(Array.isArray(defaultValue) ? { default: defaultValue } : {}),
  };
}

function normalizeOptionValues(param: McpParamDefinition): Array<string | number | boolean> {
  if (!param.options) return [];
  if (param.type === "number") {
    return param.options
      .filter((option) => option.value.trim() !== "")
      .map((option) => Number(option.value))
      .filter((value) => Number.isFinite(value));
  }
  if (param.type === "boolean") {
    return param.options
      .map((option) => option.value === "true" ? true : option.value === "false" ? false : undefined)
      .filter((value): value is boolean => value !== undefined);
  }
  return param.options.map((option) => option.value);
}

export function normalizeWorkflowMcpDefaultValue(
  param: McpParamDefinition,
  fileInputMode: McpFileInputMode,
): unknown {
  if (param.defaultValue === undefined) return undefined;
  return normalizeWorkflowMcpValue(param, param.defaultValue, fileInputMode);
}

function normalizeWorkflowMcpValue(
  param: McpParamDefinition,
  rawValue: unknown,
  fileInputMode: McpFileInputMode,
): unknown {
  if (isWorkflowMcpMultiParam(param)) {
    if (rawValue === "") return [];
    let values: unknown[];
    if (Array.isArray(rawValue)) {
      values = rawValue;
    } else if (typeof rawValue === "string") {
      try {
        const value = JSON.parse(rawValue) as unknown;
        values = Array.isArray(value) ? value : [value];
      } catch {
        values = [rawValue];
      }
    } else {
      values = [rawValue];
    }
    const normalized = values.map((value) => normalizeScalarDefaultValue(param, value, fileInputMode));
    return normalized.some((value) => value === undefined) ? undefined : normalized;
  }
  return normalizeScalarDefaultValue(param, rawValue, fileInputMode);
}

function normalizeScalarDefaultValue(
  param: McpParamDefinition,
  rawValue: unknown,
  fileInputMode: McpFileInputMode,
): unknown {
  if (param.type === "file") {
    if (fileInputMode === "local") {
      return typeof rawValue === "string" && rawValue.trim() !== "" ? rawValue : undefined;
    }
    let value = rawValue;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return undefined;
      }
    }
    return isFileIdReference(value) ? { id: value.id } : undefined;
  }
  if (param.type === "number") {
    if (typeof rawValue === "string" && rawValue.trim() === "") return undefined;
    if (rawValue === null) return undefined;
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : undefined;
  }
  if (param.type === "boolean") {
    if (rawValue === true || rawValue === "true") return true;
    if (rawValue === false || rawValue === "false") return false;
    return undefined;
  }
  return typeof rawValue === "string" ? rawValue : String(rawValue);
}

function isFileIdReference(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && typeof (value as { id?: unknown }).id === "string" &&
    (value as { id: string }).id.trim() !== "";
}
