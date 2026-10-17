import type { WorkflowRuntimeApi } from "workflow-code/runtime-api";
import type { OpenAIConversationHostInput } from "./interface";

type OpenAIWorkflowRuntimeApi = WorkflowRuntimeApi & {
  readOpenAIConversationHostInput(
    context: unknown,
  ): OpenAIConversationHostInput | undefined;
};

// Hosts inject globalThis.workflow before loading a project. The proxy keeps
// tests that replace the injected runtime after module evaluation observable.
export const workflow = new Proxy({} as OpenAIWorkflowRuntimeApi, {
  get(_target, property) {
    const value = (globalThis.workflow as OpenAIWorkflowRuntimeApi | undefined)
      ?.[property as keyof OpenAIWorkflowRuntimeApi];
    if (property === "readOpenAIConversationHostInput" && typeof value !== "function") {
      return () => undefined;
    }
    return value;
  },
});
