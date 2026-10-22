import type {
  KnowledgeDocumentRecord,
  Storage,
} from "./storage";
import { HttpError } from "./protocol";
import {
  parseKanbanBridgeCall,
  type KanbanBridgeCall,
} from "@steamharness/kanban-project";
import type { RuntimeLocale } from "steamharness";
import { readFile } from "node:fs/promises";

export function readKanbanBridgeCall(value: unknown): KanbanBridgeCall {
  try {
    return parseKanbanBridgeCall(value);
  } catch {
    throw new HttpError(400, 400, "The Kanban bridge request is invalid.");
  }
}

export async function invokeServerKanbanBridge(
  storage: Storage,
  projectName: string,
  call: KanbanBridgeCall,
  options: {
    target?: string;
    runtimeLocale?: RuntimeLocale;
    authorizeRelatedProject?: (projectId:string,write:boolean)=>Promise<void>;
  } = {},
): Promise<unknown> {
  const input = call.input;
  try {
    switch (call.operation) {
      case "runtime.getLocale":
        return options.runtimeLocale ?? "en";
      case "files.createFile": {
        const [file] = await storage.saveManagedFiles({
          projectName,
          files: [{
            name: input["name"] as string,
            mimeType: input["mimeType"] as string | undefined,
            buffer: Buffer.from(input["base64"] as string, "base64"),
          }],
        });
        return { ...file, url: `/api/projects/files/${encodeURIComponent(file!.id)}` };
      }
      case "files.readFile":
      case "files.deleteFile": {
        const fileId = input["fileId"] as string;
        const { metadata, filePath } = await storage.getManagedFile(fileId);
        if (metadata.projectId !== projectName || metadata.conversationId !== undefined) {
          throw new HttpError(404, 404, "Kanban file is unavailable in this project.");
        }
        if (call.operation === "files.deleteFile") {
          await storage.deleteManagedFile(fileId);
          return true;
        }
        return {
          file: { ...metadata, url: `/api/projects/files/${encodeURIComponent(fileId)}` },
          base64: (await readFile(filePath)).toString("base64"),
        };
      }
      case "kv.getValue": {
        const result = await storage.getProjectStorageValue({
          storageKind: "kv",
          scope: "project",
          projectId: projectName,
          key: input["key"] as string,
        });
        return result.exists ? result.value : undefined;
      }
      case "kv.setValue":
        await storage.setProjectStorageValue({
          storageKind: "kv",
          scope: "project",
          projectId: projectName,
          key: input["key"] as string,
          value: input["value"],
          source: { projectId: projectName },
        });
        return undefined;
      case "relatedProject.kv.getValue": {
        try {
          const declared = await storage.resolveKanbanRelatedProject({
            projectName,
            target: options.target,
            alias: input["alias"] as string,
          });
          const access = await storage.resolveRelatedProjectKVAccess({
            consumerProjectId: projectName,
            alias: input["alias"] as string,
            key: input["key"] as string,
            operation: "read",
          });
          if (access.targetProjectId !== declared.projectId) {
            throw new Error("Kanban related project changed.");
          }
          await options.authorizeRelatedProject?.(access.targetProjectId,false);
          const result = await storage.getProjectStorageValue({
            storageKind: "kv",
            scope: "project",
            projectId: access.targetProjectId,
            key: input["key"] as string,
          });
          return result.exists ? result.value : undefined;
        } catch(error) {
          if(error instanceof HttpError && error.statusCode===403)throw error;
          throw new HttpError(404, 404, "Kanban related project is unavailable.");
        }
      }
      case "relatedProject.kv.setValue": {
        try {
          const declared = await storage.resolveKanbanRelatedProject({
            projectName,
            target: options.target,
            alias: input["alias"] as string,
          });
          const access = await storage.resolveRelatedProjectKVAccess({
            consumerProjectId: projectName,
            alias: input["alias"] as string,
            key: input["key"] as string,
            operation: "write",
          });
          if (access.targetProjectId !== declared.projectId) {
            throw new Error("Kanban related project changed.");
          }
          await options.authorizeRelatedProject?.(access.targetProjectId,true);
          await storage.setProjectStorageValue({
            storageKind: "kv",
            scope: "project",
            projectId: access.targetProjectId,
            key: input["key"] as string,
            value: input["value"],
            source: { projectId: projectName },
          });
          return undefined;
        } catch(error) {
          if(error instanceof HttpError && error.statusCode===403)throw error;
          throw new HttpError(404, 404, "Kanban related project is unavailable.");
        }
      }
      case "knowledge.listDocuments":
        return await storage.listKnowledgeDocuments(projectName, input);
      case "knowledge.getDocument":
        return await readOptionalKnowledgeDocument(storage, projectName, input["documentId"] as string);
      case "knowledge.createDocument":
        return await storage.createKnowledgeDocument({
          projectName,
          ...(input["id"] === undefined ? {} : { id: input["id"] as string }),
          title: input["title"] as string,
          markdown: input["markdown"] as string,
        });
      case "knowledge.editDocument":
        return await storage.editKnowledgeDocument({
          projectName,
          documentId: input["documentId"] as string,
          ...(input["title"] === undefined ? {} : { title: input["title"] as string }),
          ...(input["markdown"] === undefined ? {} : { markdown: input["markdown"] as string }),
        });
      case "knowledge.deleteDocument":
        return await storage.deleteKnowledgeDocument({
          projectName,
          documentId: input["documentId"] as string,
        });
      case "knowledge.searchDocuments":
        return await storage.searchKnowledgeDocuments({
          projectName,
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
          projectName,
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
  storage: Storage,
  projectName: string,
  documentId: string,
): Promise<KnowledgeDocumentRecord | null> {
  try {
    return await storage.getKnowledgeDocument({ projectName, documentId });
  } catch (reason) {
    if (reason instanceof HttpError && reason.statusCode === 404) return null;
    throw reason;
  }
}
