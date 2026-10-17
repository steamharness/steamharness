import { WorkflowError } from "../workflow/index";
import type { WorkflowConversationCommandDefinition, WorkflowParamDefinition } from "./types";

export function assertConversationCommands(
  value: unknown,
  params: readonly WorkflowParamDefinition[],
): asserts value is WorkflowConversationCommandDefinition[] | undefined {
  if (value === undefined) return;
  function fail(message: string): never { throw new WorkflowError({ type: "input_validation", message: `Conversation commands ${message}` }); }
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const names = new Set(params.filter(param => param.panel === "slash").flatMap(param => param.type === "boolean"
    ? [param.command ?? param.name] : (param.options ?? []).map(option => option.command ?? option.value)));
  if (!Array.isArray(value)) fail("must be an array.");
  for (const item of value) {
    if (!record(item) || typeof item.command !== "string" || !/^[a-z][a-z0-9_-]*$/.test(item.command)) fail("must declare a valid command name without a leading slash.");
    if (names.has(item.command)) fail(`declare duplicate Slash command "${item.command}".`);
    names.add(item.command);
    if (typeof item.label !== "string" || !item.label.trim()) fail("labels must be non-empty strings.");
    if (item.description !== undefined && typeof item.description !== "string") fail("descriptions must be strings.");
    for (const name of ["localizedLabel", "localizedDescription"]) {
      const translations = item[name];
      if (translations !== undefined && (!record(translations) || Object.entries(translations).some(([language, text]) => !language.trim() || typeof text !== "string" || !text.trim()))) {
        fail(`${name} must map languages to non-empty strings.`);
      }
    }
    if (!record(item.action) || !["prompt", "export"].includes(String(item.action.kind))) fail("actions must declare kind prompt or export.");
    if (item.action.kind === "prompt" && (typeof item.action.text !== "string" || !item.action.text.trim() || item.action.text.length > 100_000)) fail("prompt actions must declare non-empty text of at most 100000 characters.");
    if (item.action.kind === "export" && item.action.text !== undefined) fail("export actions cannot declare prompt text.");
  }
}
