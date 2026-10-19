import { HarnessError } from "../workflow/index";
import type { ConversationFooterItem, ParamDefinition } from "./types";

export function assertConversationFooter(
  value: unknown,
  params: readonly ParamDefinition[],
): asserts value is ConversationFooterItem[] | undefined {
  if (value === undefined) return;
  function fail(message: string): never { throw new HarnessError({ type: "input_validation", message: `Conversation footer ${message}` }); }
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const names = new Set(params.map(param => param.name));
  if (!Array.isArray(value)) fail("must be an array.");
  for (const item of value) {
    if (!record(item)) fail("items must be objects.");
    if ((item.text === undefined) === (item.param === undefined)) fail("items must declare exactly one of text or param.");
    if (item.text !== undefined && (typeof item.text !== "string" || !item.text.trim())) fail("text must be a non-empty string.");
    if (item.param !== undefined && (typeof item.param !== "string" || !names.has(item.param))) fail(`references unknown parameter "${String(item.param)}".`);
    if (item.localizedText !== undefined && (item.text === undefined || !record(item.localizedText) ||
        Object.values(item.localizedText).some(text => typeof text !== "string" || !text.trim()))) {
      fail("localizedText must contain non-empty strings for a text item.");
    }
    if (item.when !== undefined && (!record(item.when) || typeof item.when.param !== "string" ||
        !names.has(item.when.param) || typeof item.when.value !== "string")) {
      fail("conditions must name an existing parameter and a string value.");
    }
  }
}
