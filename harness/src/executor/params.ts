import { HarnessError } from "../workflow/index";
import { getUserSettings } from "../user-settings";
import type {
  ParamDefinition,
  ParamDeclaration,
  ParamResolveResult,
  ParamStatePatch,
  ParamValue,
  ParamValues,
} from "./types";
import { assertProjectParamDefinitions, isProjectDateParamControl, normalizeProjectParamDeclarations } from "./param-definition";

export function parseProjectParamValues(
  params: ParamDeclaration[] | undefined,
  args: string[],
): ParamValues {
  const definitions = normalizeProjectParamDeclarations(params).params;
  const values: ParamValues = Object.fromEntries(definitions.map((param) => [
    param.name,
    param.userSetting ? getUserSettings().agent.permissionPolicy
      : isMultiParam(param) ? readMultiValue(param.defaultValue ?? "") : param.defaultValue ?? "",
  ]));
  const flags = new Map<string, ParamDefinition>();
  const positional = definitions.filter((param) => param.type === "positional");

  for (const param of definitions) {
    if (param.type === "positional") continue;
    if (param.flag) flags.set(param.flag, param);
    if (param.shortFlag) flags.set(param.shortFlag, param);
  }

  let positionalIndex = 0;
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === undefined) break;
    const param = flags.get(arg);
    if (param) {
      if (param.userSetting?.mode === "fixed") { index += 2; continue; }
      if (isMultiParam(param)) {
        values[param.name] = normalizeValue(param, args[index + 1] ?? "");
        index += 2;
      } else if (param.type === "boolean") {
        const next = args[index + 1];
        values[param.name] = next === "true" || next === "false" ? next : "true";
        index += next === "true" || next === "false" ? 2 : 1;
      } else {
        values[param.name] = normalizeValue(param, args[index + 1] ?? "");
        index += 2;
      }
      continue;
    }

    const positionalParam = positional[positionalIndex];
    if (positionalParam) {
      values[positionalParam.name] = normalizeValue(positionalParam, arg);
      positionalIndex += 1;
    }
    index += 1;
  }

  return values;
}

export function validateProjectParamResolveResult(
  params: ParamDeclaration[] | undefined,
  result: ParamResolveResult,
): ParamResolveResult {
  const fields = normalizeProjectParamDeclarations(params).params;
  assertProjectParamDefinitions(fields);
  const definitions = new Map(fields.map((param) => [param.name, param]));
  const patches: Record<string, ParamStatePatch> = {};

  for (const [name, patch] of Object.entries(result.params ?? {})) {
    const param = definitions.get(name);
    if (!param) throw resolverError(`Unknown parameter "${name}" in resolveParams result.`);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw resolverError(`Parameter patch "${name}" must be an object.`);
    }
    if (
      isProjectDateParamControl(param.control) &&
      (patch.resolvedOptions !== undefined || patch.options !== undefined)
    ) {
      throw resolverError(`Date parameter "${name}" cannot resolve options.`);
    }
    validateResolvedOptions(name, patch.resolvedOptions);
    if (patch.value !== undefined && patch.value !== null) validatePatchValue(param, patch.value);
    const availableOptions = patch.resolvedOptions === undefined || patch.resolvedOptions === null
      ? param.options
      : patch.resolvedOptions;
    for (const optionValue of Object.keys(patch.options ?? {})) {
      if (!availableOptions?.some((option) => option.value === optionValue)) {
        throw resolverError(`Unknown option "${optionValue}" for parameter "${name}".`);
      }
    }
    patches[name] = patch;
  }

  const commands = new Set<string>();
  for (const field of fields.filter(field => field.panel === "slash")) {
    const options = patches[field.name]?.resolvedOptions ?? field.options ?? [];
    const entries = field.type === "boolean" ? [field.command ?? field.name] : options.map(option =>
      option.command ?? field.options?.find(original => original.value === option.value)?.command ?? option.value);
    for (const command of entries) {
      if (!/^[a-z][a-z0-9_-]*$/.test(command) || commands.has(command)) {
        throw resolverError(`Slash command "${command}" must be unique and match /^[a-z][a-z0-9_-]*$/.`);
      }
      commands.add(command);
    }
  }

  return { params: patches };
}

function validateResolvedOptions(
  paramName: string,
  options: ParamStatePatch["resolvedOptions"],
): void {
  if (options === undefined || options === null) return;
  if (!Array.isArray(options)) {
    throw resolverError(`Resolved options for parameter "${paramName}" must be an array or null.`);
  }
  const values = new Set<string>();
  for (const option of options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      throw resolverError(`Resolved options for parameter "${paramName}" must contain objects.`);
    }
    if (typeof option.value !== "string" || option.value.trim() === "") {
      throw resolverError(`Resolved option values for parameter "${paramName}" must be non-empty strings.`);
    }
    if (values.has(option.value)) {
      throw resolverError(`Duplicate resolved option "${option.value}" for parameter "${paramName}".`);
    }
    if (option.label !== undefined && typeof option.label !== "string") {
      throw resolverError(`Resolved option label "${option.value}" for parameter "${paramName}" must be a string.`);
    }
    if (option.description !== undefined && typeof option.description !== "string") {
      throw resolverError(`Resolved option description "${option.value}" for parameter "${paramName}" must be a string.`);
    }
    if (option.command !== undefined && typeof option.command !== "string") {
      throw resolverError(`Resolved option command "${option.value}" for parameter "${paramName}" must be a string.`);
    }
    values.add(option.value);
  }
}

function validatePatchValue(param: ParamDefinition, value: ParamValue): void {
  if (isMultiParam(param)) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw resolverError(`Parameter "${param.name}" requires a string array value.`);
    }
    return;
  }
  if (typeof value !== "string") {
    throw resolverError(`Parameter "${param.name}" requires a string value.`);
  }
}

function normalizeValue(param: ParamDefinition, value: string): ParamValue {
  if (param.userSetting && (value === "" || value === "inherit")) return getUserSettings().agent.permissionPolicy;
  return isMultiParam(param) ? readMultiValue(value) : value;
}

function isMultiParam(param: ParamDefinition): boolean {
  return param.type !== "file" && (param.multiple === true || param.control === "checkboxes");
}

function readMultiValue(value: string): string[] {
  if (value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [value];
  } catch {
    return [value];
  }
}

function resolverError(message: string): HarnessError {
  return new HarnessError({ type: "input_validation", message });
}
