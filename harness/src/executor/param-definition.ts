import { HarnessError } from "../workflow/index";
import type {
  DateParamControl,
  ParamControl,
  ParamDeclaration,
  ParamDefinition,
  ParamLayout,
} from "./types";

const DATE_PARAM_CONTROLS = new Set<ParamControl>([
  "date",
  "time",
  "datetime",
  "date-range",
]);

export function isProjectDateParamControl(
  control: ParamControl | undefined,
): control is DateParamControl {
  return control !== undefined && DATE_PARAM_CONTROLS.has(control);
}

export function readProjectParamDefinitionError(
  param: ParamDefinition,
  declaredProperties?: { options?: boolean },
): string | undefined {
  if (param.userSetting !== undefined) {
    const binding = param.userSetting;
    if (!binding || typeof binding !== "object" || !["agent.permissionPolicy", "agent.model"].includes(binding.key) ||
      binding.mode !== undefined && binding.mode !== "default" && binding.mode !== "fixed") {
      return `Parameter "${param.name}" must bind a supported user setting with mode default or fixed.`;
    }
    if (param.type !== "string" || param.multiple || param.control === "checkboxes" || param.panel === "slash" || param.panel === "mode" ||
      param.defaultValue !== undefined) {
      return `User setting parameter "${param.name}" must be a single string field without defaultValue, mode, or Slash placement.`;
    }
  }
  if (param.step !== undefined && (!Number.isInteger(param.step) || param.step < 1)) {
    return `Parameter "${param.name}" step must be a positive integer.`;
  }
  if (param.control === "audio" || param.audio !== undefined) {
    if (param.type !== "file" || param.control !== "audio") {
      return `Audio parameter "${param.name}" must use type: "file" and control: "audio".`;
    }
    if (param.multiple === true || param.options !== undefined || param.panel === "quick") {
      return `Audio parameter "${param.name}" accepts a single file and cannot declare options or panel: "quick".`;
    }
    if (param.audio !== undefined && (typeof param.audio !== "object" || param.audio === null || Array.isArray(param.audio))) {
      return `Audio parameter "${param.name}" limits must be an object.`;
    }
    for (const [key, value] of Object.entries(param.audio ?? {})) {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (key === "maxBytes" && !Number.isInteger(value)))) {
        return `Audio parameter "${param.name}" ${key} must be a positive finite ${key === "maxBytes" ? "integer" : "number"}.`;
      }
    }
  }
  if (!isProjectDateParamControl(param.control)) return undefined;
  if (param.type !== "string") {
    return `Date parameter "${param.name}" must use type: "string".`;
  }
  if (param.panel === "quick") {
    return `Date parameter "${param.name}" cannot use panel: "quick".`;
  }
  if (param.options !== undefined || declaredProperties?.options === true) {
    return `Date parameter "${param.name}" cannot declare options.`;
  }
  if (param.multiple === true) {
    return `Date parameter "${param.name}" cannot use multiple: true.`;
  }
  return undefined;
}

export function normalizeProjectParamDeclarations(
  declarations: readonly ParamDeclaration[] | undefined,
): { params: ParamDefinition[]; layout?: ParamLayout } {
  const params: ParamDefinition[] = [];
  const layout: ParamLayout = { actions: [] };
  const names = new Set<string>();
  const flags = new Set<string>();
  const groupIds = new Set<string>();
  const commands = new Set<string>();
  const addCommand = (command: string) => {
    if (typeof command !== "string" || !/^[a-z][a-z0-9_-]*$/.test(command) || commands.has(command)) {
      throw paramError(`Slash command "${command}" must be unique and match /^[a-z][a-z0-9_-]*$/.`);
    }
    commands.add(command);
  };

  const addField = (field: ParamDefinition) => {
    const error = readProjectParamDefinitionError(field);
    if (error !== undefined) throw paramError(error);
    if (typeof field.name !== "string" || field.name.trim() === "" || names.has(field.name)) {
      throw paramError(`Parameter name "${String(field.name)}" must be non-empty and unique.`);
    }
    names.add(field.name);
    for (const flag of [field.flag, field.shortFlag]) {
      if (flag === undefined) continue;
      if (typeof flag !== "string" || flag.trim() === "" || flags.has(flag)) {
        throw paramError(`Parameter flag "${String(flag)}" must be non-empty and unique.`);
      }
      flags.add(flag);
    }
    params.push(field);
  };

  for (const declaration of declarations ?? []) {
    if ("kind" in declaration && declaration.kind === "auxiliary") {
      if (typeof declaration.id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(declaration.id) || groupIds.has(declaration.id)) {
        throw paramError(`Auxiliary group id "${String(declaration.id)}" must be unique and match /^[a-z][a-z0-9_-]*$/.`);
      }
      if (typeof declaration.label !== "string" || declaration.label.trim() === "") {
        throw paramError(`Auxiliary group "${declaration.id}" must have a non-empty label.`);
      }
      if (!Array.isArray(declaration.fields) || declaration.fields.length === 0) {
        throw paramError(`Auxiliary group "${declaration.id}" must contain fields.`);
      }
      groupIds.add(declaration.id);
      for (const field of declaration.fields) {
        if (field.panel !== undefined || "kind" in field) {
          throw paramError(`Auxiliary field "${field.name}" cannot declare its own placement.`);
        }
        addField({ ...field, panel: "auxiliary" });
      }
      layout.actions.push({
        kind: "auxiliary",
        id: declaration.id,
        label: declaration.label,
        params: declaration.fields.map((field) => field.name),
      });
    } else if ("kind" in declaration && declaration.kind === "quick") {
      if (typeof declaration.id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(declaration.id) || groupIds.has(declaration.id)) {
        throw paramError(`Quick group id "${String(declaration.id)}" must be unique and match /^[a-z][a-z0-9_-]*$/.`);
      }
      if (typeof declaration.label !== "string" || declaration.label.trim() === "") {
        throw paramError(`Quick group "${declaration.id}" must have a non-empty label.`);
      }
      if (declaration.icon !== undefined && (typeof declaration.icon !== "string" || !/^[a-z][a-z0-9-]*$/.test(declaration.icon))) {
        throw paramError(`Quick group "${declaration.id}" icon must be a Codicon name matching /^[a-z][a-z0-9-]*$/.`);
      }
      if (!Array.isArray(declaration.fields) || declaration.fields.length === 0) {
        throw paramError(`Quick group "${declaration.id}" must contain fields.`);
      }
      groupIds.add(declaration.id);
      const groupNames = new Set<string>();
      for (const field of declaration.fields) {
        if (field.panel !== undefined || field.type !== "string" ||
          !["select", "radio", "checkboxes"].includes(field.control ?? "")) {
          throw paramError(`Quick group "${declaration.id}" field "${field.name}" must be a string selector without panel.`);
        }
        addField({ ...field, panel: "quick" });
        groupNames.add(field.name);
      }
      if (!Array.isArray(declaration.summary) || declaration.summary.length === 0 ||
        new Set(declaration.summary).size !== declaration.summary.length ||
        declaration.summary.some((name) => !groupNames.has(name))) {
        throw paramError(`Quick group "${declaration.id}" summary must name distinct fields in that group.`);
      }
      layout.actions.push({
        kind: "quick",
        id: declaration.id,
        label: declaration.label,
        ...(declaration.icon === undefined ? {} : { icon: declaration.icon }),
        summary: [...declaration.summary],
        params: declaration.fields.map((field) => field.name),
      });
    } else if ("kind" in declaration && declaration.kind === "slash") {
      if (!declaration.flag || !["string", "boolean"].includes(declaration.type) ||
          "control" in declaration || "panel" in declaration || "multiple" in declaration) {
        throw paramError(`Slash parameter "${declaration.name}" must be a single string selector or boolean with a flag.`);
      }
      const { kind: _kind, ...field } = declaration;
      let defaultValue = declaration.defaultValue;
      if (declaration.type === "boolean") {
        if (declaration.options !== undefined || defaultValue !== undefined && !["true", "false"].includes(defaultValue)) {
          throw paramError(`Boolean Slash parameter "${declaration.name}" cannot declare options and must default to true or false.`);
        }
        addCommand(declaration.command ?? declaration.name);
        defaultValue ??= "false";
      } else {
        if (declaration.command !== undefined || !Array.isArray(declaration.options) || !declaration.options.length) {
          throw paramError(`String Slash parameter "${declaration.name}" must declare options with individual commands.`);
        }
        const optionValues = new Set<string>();
        for (const option of declaration.options) {
          if (!option || typeof option.value !== "string" || option.value.trim() === "" || optionValues.has(option.value)) {
            throw paramError(`Slash parameter "${declaration.name}" requires distinct non-empty option values.`);
          }
          optionValues.add(option.value);
          addCommand(option.command ?? option.value);
        }
        defaultValue ??= declaration.options[0]!.value;
        if (!optionValues.has(defaultValue)) {
          throw paramError(`Slash parameter "${declaration.name}" defaultValue must name an option.`);
        }
      }
      addField({ ...field, defaultValue, panel: "slash", ...(declaration.type === "string" ? { control: "select" } : {}) });
      layout.actions.push({ kind: "slash", name: declaration.name });
    } else if ("kind" in declaration && declaration.kind === "mode") {
      if (!Array.isArray(declaration.options) || declaration.options.length < 2) {
        throw paramError(`Mode parameter "${declaration.name}" requires at least two options.`);
      }
      const optionValues = new Set<string>();
      for (const option of declaration.options) {
        if (typeof option?.value !== "string" || option.value.trim() === "" || optionValues.has(option.value)) {
          throw paramError(`Mode parameter "${declaration.name}" requires distinct non-empty option values.`);
        }
        optionValues.add(option.value);
      }
      const defaultValue = declaration.defaultValue ?? declaration.options[0]!.value;
      if (!optionValues.has(defaultValue)) {
        throw paramError(`Mode parameter "${declaration.name}" defaultValue must name an option.`);
      }
      const { kind: _kind, ...field } = declaration;
      addField({ ...field, defaultValue, type: "string", control: "select", panel: "mode" });
      layout.actions.push({ kind: "mode", name: declaration.name });
    } else {
      if (declaration.panel !== undefined) {
        throw paramError(`Parameter "${declaration.name}" must declare placement through an auxiliary, quick, mode, or slash entry.`);
      }
      addField(declaration);
    }
  }
  return { params, layout: layout.actions.length > 0 ? layout : undefined };
}

export function assertProjectParamDeclarations(
  declarations: readonly ParamDeclaration[] | undefined,
  projectType: "conversation" | "workflow",
): void {
  const { params, layout } = normalizeProjectParamDeclarations(declarations);
  if (projectType === "conversation") {
    if (declarations?.some((declaration) => !("kind" in declaration))) {
      throw paramError("Conversation uses the standard message input. Declare parameters inside auxiliary, quick, mode, or slash entries.");
    }
    const reservedFlags = new Set(["--message", "--images", "--videos", "--files"]);
    if (params.some((param) => reservedFlags.has(param.flag ?? "") || reservedFlags.has(param.shortFlag ?? ""))) {
      throw paramError("Conversation message and attachment flags are reserved for the standard input.");
    }
  }
  if (projectType === "workflow" && layout?.actions.some((action) => action.kind === "mode" || action.kind === "slash")) {
    throw paramError("Composer mode and Slash parameters are only supported by Conversation executors.");
  }
}

function paramError(message: string): HarnessError {
  return new HarnessError({ type: "input_validation", message });
}

export function assertProjectParamDefinitions(
  params: readonly ParamDefinition[] | undefined,
): void {
  for (const param of params ?? []) {
    const error = readProjectParamDefinitionError(param);
    if (error === undefined) continue;
    throw new HarnessError({ type: "input_validation", message: error });
  }
}
