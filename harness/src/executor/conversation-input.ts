import { WorkflowError } from "../workflow/index";
import type { WorkflowConversationUserInputDefinition, WorkflowParamDefinition } from "./types";

export function assertConversationUserInput(
  value: unknown,
  params: WorkflowParamDefinition[],
): asserts value is WorkflowConversationUserInputDefinition | undefined {
  if (value === undefined) return;
  function fail(message: string): never { throw new WorkflowError({ type: "input_validation", message: `Conversation userInput ${message}` }); }
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const matchValue = (item: unknown): boolean => typeof item === "string" || typeof item === "boolean"
    || typeof item === "number" && Number.isFinite(item) || Array.isArray(item) && item.every(entry => typeof entry === "string");
  if (!record(value)) fail("must be an object.");
  if (value.hideComposer !== undefined && typeof value.hideComposer !== "boolean") fail("hideComposer must be a boolean.");
  if (value.effects === undefined) return;
  if (!Array.isArray(value.effects)) fail("effects must be an array.");
  for (const effect of value.effects) {
    if (!record(effect) || !record(effect.when) || !record(effect.params) || !Object.keys(effect.params).length) {
      fail("effects must declare when and non-empty params objects.");
    }
    const when = effect.when;
    if (Object.keys(when).some(key => !["type", "nodeName", "values"].includes(key))) fail("when contains an unknown condition.");
    for (const key of ["type", "nodeName"] as const) {
      if (when[key] !== undefined && (typeof when[key] !== "string" || !when[key].trim())) fail(`when.${key} must be a non-empty string.`);
    }
    if (when.values !== undefined && (!record(when.values) || !Object.keys(when.values).length ||
        Object.entries(when.values).some(([name, entry]) => !name.trim() || !matchValue(entry)))) {
      fail("when.values must contain named string, number, boolean or string array values.");
    }
    if (when.type === undefined && when.nodeName === undefined && when.values === undefined) fail("effects require at least one condition.");
    for (const [name, entry] of Object.entries(effect.params)) {
      const field = params.find(field => field.name === name);
      if (!field) fail(`references unknown parameter "${name}".`);
      if (typeof entry !== "string" && !(Array.isArray(entry) && entry.every(item => typeof item === "string"))) fail(`params.${name} must contain a string or string array.`);
      const multiple = field.type !== "file" && (field.multiple === true || field.control === "checkboxes");
      if (multiple !== Array.isArray(entry)) fail(`params.${name} must match the parameter's single or multiple value type.`);
      if (field.type === "boolean" && entry !== "true" && entry !== "false") fail(`params.${name} must contain "true" or "false".`);
    }
  }
}
