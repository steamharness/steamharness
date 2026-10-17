import {
  isOpenAIConversationHostInput,
  type OpenAIConversationHostInput,
} from "@steamharness/openai-responses";
import { WorkflowError } from "../workflow/errors";
import type { WorkflowExecutorContext } from "./types";

export type { OpenAIConversationHostInput } from "@steamharness/openai-responses";

export function readOpenAIConversationHostInput(
  context: Pick<WorkflowExecutorContext, "hostInput">,
): OpenAIConversationHostInput | undefined {
  if (context.hostInput === undefined) return undefined;
  if (!isRecord(context.hostInput) || context.hostInput.kind !== "openai.responses") {
    return undefined;
  }
  if (!isOpenAIConversationHostInput(context.hostInput)) {
    throw new WorkflowError({
      type: "input_validation",
      message: "The OpenAI Responses host input is invalid.",
    });
  }
  return context.hostInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
