import type { NodeContext, WorkflowStorageLocationContext } from "../../types/context";

export function selectWorkflowStorage(
  context: Pick<NodeContext, "storage">,
  location: "local" | "server" = "local",
): WorkflowStorageLocationContext {
  return context.storage[location];
}
