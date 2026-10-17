import type {
  KnowledgeRepository,
  KnowledgeResult,
} from "@workflow-code/knowledge-base";
import { ServerApiClient } from "../../api";
import { isApiSuccess, type ApiResponse } from "../../types";

function toKnowledgeResult<T>(response: ApiResponse<T>): KnowledgeResult<T> {
  if (isApiSuccess(response)) {
    return { errCode: 0, errMessage: "", data: response.data };
  }
  return { errCode: response.errCode, errMessage: response.errMessage };
}

// Keep the Server transport independent of the management UI presentation.
export function createServerKnowledgeRepository(
  client: ServerApiClient,
  workflowName: string,
): KnowledgeRepository {
  return {
    async listDocuments({ pageSize, cursor, signal }) {
      return toKnowledgeResult(await client.listKnowledgeDocuments(workflowName, { pageSize, cursor, signal }));
    },
    async getDocument(documentId, { signal } = {}) {
      return toKnowledgeResult(await client.getKnowledgeDocument(workflowName, documentId, { signal }));
    },
    async createDocument(input, { signal } = {}) {
      return toKnowledgeResult(await client.createKnowledgeDocument(workflowName, input, { response: "summary", signal }));
    },
    async updateDocument(documentId, input, { signal } = {}) {
      return toKnowledgeResult(await client.editKnowledgeDocument(workflowName, documentId, input, { response: "summary", signal }));
    },
    async deleteDocument(documentId, { signal } = {}) {
      return toKnowledgeResult(await client.deleteKnowledgeDocument(workflowName, documentId, { signal }));
    },
    async searchDocuments({ query, beforeLines, afterLines, pageSize, cursor, signal }) {
      return toKnowledgeResult(await client.searchKnowledgeDocuments(workflowName, {
        query,
        beforeLines,
        afterLines,
        pageSize,
        cursor,
        signal,
      }));
    },
    async readDocumentLines(documentId, { startLine, endLine, signal }) {
      return toKnowledgeResult(await client.readKnowledgeDocumentLines(workflowName, documentId, {
        startLine,
        endLine,
        signal,
      }));
    },
  };
}
