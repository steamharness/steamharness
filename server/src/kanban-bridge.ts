import type {
  WorkflowKnowledgeDocumentRecord,
  WorkflowStorage,
} from "./storage";
import { HttpError } from "./protocol";
import {
  parseKanbanBridgeCall,
  type KanbanBridgeCall,
} from "@workflow-code/kanban-project";
import type { WorkflowRuntimeLocale } from "workflow-code";
import { readFile } from "node:fs/promises";

export function readKanbanBridgeCall(value: unknown): KanbanBridgeCall {
  try {
    return parseKanbanBridgeCall(value);
  } catch {
    throw new HttpError(400, 400, "The Kanban bridge request is invalid.");
  }
}

export async function invokeServerKanbanBridge(
  storage: WorkflowStorage,
  workflowName: string,
  call: KanbanBridgeCall,
  options: {
    target?: string;
    runtimeLocale?: WorkflowRuntimeLocale;
  } = {},
): Promise<unknown> {
  const input = call.input;
  try {
    switch (call.operation) {
      case "runtime.getLocale":
        return options.runtimeLocale ?? "en";
      case "files.createFile": {
        const [file] = await storage.saveManagedFiles({
          workflowName,
          files: [{
            name: input["name"] as string,
            mimeType: input["mimeType"] as string | undefined,
            buffer: Buffer.from(input["base64"] as string, "base64"),
          }],
        });
        return { ...file, url: `/api/workflows/files/${encodeURIComponent(file!.id)}` };
      }
      case "files.readFile":
      case "files.deleteFile": {
        const fileId = input["fileId"] as string;
        const { metadata, filePath } = await storage.getManagedFile(fileId);
        if (metadata.workflowId !== workflowName || metadata.conversationId !== undefined) {
          throw new HttpError(404, 404, "Kanban file is unavailable in this project.");
        }
        if (call.operation === "files.deleteFile") {
          await storage.deleteManagedFile(fileId);
          return true;
        }
        return {
          file: { ...metadata, url: `/api/workflows/files/${encodeURIComponent(fileId)}` },
          base64: (await readFile(filePath)).toString("base64"),
        };
      }
      case "kv.getValue": {
        const result = await storage.getProjectStorageValue({
          storageKind: "kv",
          scope: "project",
          projectId: workflowName,
          key: input["key"] as string,
        });
        return result.exists ? result.value : undefined;
      }
      case "kv.setValue":
        await storage.setProjectStorageValue({
          storageKind: "kv",
          scope: "project",
          projectId: workflowName,
          key: input["key"] as string,
          value: input["value"],
          source: { projectId: workflowName },
        });
        return undefined;
      case "relatedProject.kv.getValue": {
        try {
          const declared = await storage.resolveKanbanRelatedProject({
            workflowName,
            target: options.target,
            alias: input["alias"] as string,
          });
          const access = await storage.resolveRelatedProjectKVAccess({
            consumerProjectId: workflowName,
            alias: input["alias"] as string,
            key: input["key"] as string,
            operation: "read",
          });
          if (access.targetProjectId !== declared.projectId) {
            throw new Error("Kanban related project changed.");
          }
          const result = await storage.getProjectStorageValue({
            storageKind: "kv",
            scope: "project",
            projectId: access.targetProjectId,
            key: input["key"] as string,
          });
          return result.exists ? result.value : undefined;
        } catch {
          throw new HttpError(404, 404, "Kanban related project is unavailable.");
        }
      }
      case "relatedProject.kv.setValue": {
        try {
          const declared = await storage.resolveKanbanRelatedProject({
            workflowName,
            target: options.target,
            alias: input["alias"] as string,
          });
          const access = await storage.resolveRelatedProjectKVAccess({
            consumerProjectId: workflowName,
            alias: input["alias"] as string,
            key: input["key"] as string,
            operation: "write",
          });
          if (access.targetProjectId !== declared.projectId) {
            throw new Error("Kanban related project changed.");
          }
          await storage.setProjectStorageValue({
            storageKind: "kv",
            scope: "project",
            projectId: access.targetProjectId,
            key: input["key"] as string,
            value: input["value"],
            source: { projectId: workflowName },
          });
          return undefined;
        } catch {
          throw new HttpError(404, 404, "Kanban related project is unavailable.");
        }
      }
      case "knowledge.listDocuments":
        return await storage.listKnowledgeDocuments(workflowName, input);
      case "knowledge.getDocument":
        return await readOptionalKnowledgeDocument(storage, workflowName, input["documentId"] as string);
      case "knowledge.createDocument":
        return await storage.createKnowledgeDocument({
          workflowName,
          ...(input["id"] === undefined ? {} : { id: input["id"] as string }),
          title: input["title"] as string,
          markdown: input["markdown"] as string,
        });
      case "knowledge.editDocument":
        return await storage.editKnowledgeDocument({
          workflowName,
          documentId: input["documentId"] as string,
          ...(input["title"] === undefined ? {} : { title: input["title"] as string }),
          ...(input["markdown"] === undefined ? {} : { markdown: input["markdown"] as string }),
        });
      case "knowledge.deleteDocument":
        return await storage.deleteKnowledgeDocument({
          workflowName,
          documentId: input["documentId"] as string,
        });
      case "knowledge.searchDocuments":
        return await storage.searchKnowledgeDocuments({
          workflowName,
          query: input["query"] as string,
          ...(input["documentId"] === undefined ? {} : { documentId: input["documentId"] as string }),
          ...(input["beforeLines"] === undefined ? {} : { beforeLines: input["beforeLines"] as number }),
          ...(input["afterLines"] === undefined ? {} : { afterLines: input["afterLines"] as number }),
          ...(input["maxMatches"] === undefined ? {} : { maxMatches: input["maxMatches"] as number }),
          ...(input["pageSize"] === undefined ? {} : { pageSize: input["pageSize"] as number }),
          ...(input["cursor"] === undefined ? {} : { cursor: input["cursor"] as string }),
        });
      case "knowledge.readDocumentLines":
        return await storage.readKnowledgeDocumentLines({
          workflowName,
          documentId: input["documentId"] as string,
          startLine: input["startLine"] as number,
          endLine: input["endLine"] as number,
        });
    }
  } catch (reason) {
    if (reason instanceof HttpError) throw reason;
    throw new HttpError(500, 500, "Kanban project data operation failed.");
  }
}

async function readOptionalKnowledgeDocument(
  storage: WorkflowStorage,
  workflowName: string,
  documentId: string,
): Promise<WorkflowKnowledgeDocumentRecord | null> {
  try {
    return await storage.getKnowledgeDocument({ workflowName, documentId });
  } catch (reason) {
    if (reason instanceof HttpError && reason.statusCode === 404) return null;
    throw reason;
  }
}
