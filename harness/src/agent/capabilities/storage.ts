import type { NodeContext, StorageLocationContext } from "../../types/context";

export function selectProjectStorage(
  context: Pick<NodeContext, "storage">,
  location: "local" | "server" = "local",
): StorageLocationContext {
  return context.storage[location];
}
