import {
  isOpenAIConversationHostInput,
  type OpenAIConversationHostInput,
} from "@steamharness/openai-responses";
import { HarnessError } from "../workflow/errors";
import type { ExecutorContext } from "./types";

export type { OpenAIConversationHostInput } from "@steamharness/openai-responses";

export function readOpenAIConversationHostInput(
  context: Pick<ExecutorContext, "hostInput">,
): OpenAIConversationHostInput | undefined {
  if (context.hostInput === undefined) return undefined;
  if (!isRecord(context.hostInput) || context.hostInput.kind !== "openai.responses") {
    return undefined;
  }
  if (!isOpenAIConversationHostInput(context.hostInput)) {
    throw new HarnessError({
      type: "input_validation",
      message: "The OpenAI Responses host input is invalid.",
    });
  }
  return context.hostInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
