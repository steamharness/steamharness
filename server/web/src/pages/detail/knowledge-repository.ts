import type {
  KnowledgeRepository,
  KnowledgeResult,
} from "@steamharness/knowledge-base";
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
  projectName: string,
): KnowledgeRepository {
  return {
    async listDocuments({ pageSize, cursor, signal }) {
      return toKnowledgeResult(await client.listKnowledgeDocuments(projectName, { pageSize, cursor, signal }));
    },
    async getDocument(documentId, { signal } = {}) {
      return toKnowledgeResult(await client.getKnowledgeDocument(projectName, documentId, { signal }));
    },
    async createDocument(input, { signal } = {}) {
      return toKnowledgeResult(await client.createKnowledgeDocument(projectName, input, { response: "summary", signal }));
    },
    async updateDocument(documentId, input, { signal } = {}) {
      return toKnowledgeResult(await client.editKnowledgeDocument(projectName, documentId, input, { response: "summary", signal }));
    },
    async deleteDocument(documentId, { signal } = {}) {
      return toKnowledgeResult(await client.deleteKnowledgeDocument(projectName, documentId, { signal }));
    },
    async searchDocuments({ query, beforeLines, afterLines, pageSize, cursor, signal }) {
      return toKnowledgeResult(await client.searchKnowledgeDocuments(projectName, {
        query,
        beforeLines,
        afterLines,
        pageSize,
        cursor,
        signal,
      }));
    },
    async readDocumentLines(documentId, { startLine, endLine, signal }) {
      return toKnowledgeResult(await client.readKnowledgeDocumentLines(projectName, documentId, {
        startLine,
        endLine,
        signal,
      }));
    },
  };
}
