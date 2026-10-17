import type { WorkflowRuntimeApi } from "workflow-code/runtime-api";

export const workflow = new Proxy({} as WorkflowRuntimeApi, {
  get(_target, property) {
    return globalThis.workflow?.[property as keyof WorkflowRuntimeApi];
  },
});
