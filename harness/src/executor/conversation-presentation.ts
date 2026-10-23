import { HarnessError } from "../workflow/index";

export function assertConversationPresentation(value: unknown): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new HarnessError({ type: "input_validation", message: "Conversation collapseIntermediate must be a boolean." });
  }
}
