import type { NodeContext } from "../../types/context";
import { databaseKnowledgeContext } from "../../databases/knowledge-context";
export function selectDatabase(context: Pick<NodeContext, "databases">, alias: string) {
  if (typeof alias !== "string" || !alias.trim()) throw new Error("A declared database alias is required.");
  const database = context.databases.get(alias);
  return { kv: database.kv, ...databaseKnowledgeContext(database) };
}
