import { readWorkflowCliAuthConfigSync } from "../auth-config";
import {
  createWorkflowFileStore,
  createWorkflowFileCreateUnavailableError,
  normalizeWorkflowFileReference,
  createResolvedWorkflowFile,
  type WorkflowCreateFileInput,
  type WorkflowFileReference,
  type WorkflowFileStore,
} from "./index";
import { WorkflowError } from "../workflow/errors";

interface ApiResponse<T> {
  errCode: number;
  errMessage: string;
  data?: T;
}

export interface RemoteWorkflowFileStoreOptions {
  serverUrl: string;
  token: string;
  workflowName: string;
  conversationId?: string;
}

export class RemoteWorkflowFileStore implements WorkflowFileStore {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly workflowName: string;
  private readonly conversationId?: string;
  private readonly fallbackStore: WorkflowFileStore;

  constructor(options: RemoteWorkflowFileStoreOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.token = options.token.trim();
    this.workflowName = options.workflowName;
    this.conversationId = options.conversationId;
    this.fallbackStore = createWorkflowFileStore({});
  }

  async resolveFile(reference: WorkflowFileReference) {
    if (reference.storage !== "server") return this.fallbackStore.resolveFile(reference);
    const normalized = normalizeWorkflowFileReference(reference);
    if (normalized.workflowId !== undefined && normalized.workflowId !== this.workflowName) {
      throw new WorkflowError({ type: "input_validation", message: "Workflow file belongs to another project." });
    }
    if (this.serverUrl === "" || this.token === "") throw createWorkflowFileCreateUnavailableError();
    return createResolvedWorkflowFile(normalized, async () => {
      // Use the managed endpoint, never a caller-supplied URL or path with credentials.
      const response = await fetch(
        `${this.serverUrl}/api/workflows/files/${encodeURIComponent(normalized.id)}`,
        { headers: { Authorization: `Bearer ${this.token}` }, redirect: "error" },
      );
      if (!response.ok) {
        const payload = await readApiResponse(response);
        throw new WorkflowError({
          type: "workflow_execution",
          message: payload.errMessage || `Workflow file read failed with HTTP ${response.status}.`,
          metadata: { fileId: normalized.id, status: response.status },
        });
      }
      return Buffer.from(await response.arrayBuffer());
    });
  }

  async createFile(input: WorkflowCreateFileInput): Promise<WorkflowFileReference> {
    if (this.serverUrl === "" || this.token === "") {
      throw createWorkflowFileCreateUnavailableError();
    }

    const query = new URLSearchParams({
      fileName: input.name,
      mimeType: input.mimeType ?? "application/octet-stream",
    });
    const conversationId = input.conversationId?.trim() || this.conversationId?.trim();
    if (conversationId) {
      query.set("conversationId", conversationId);
    }

    let response: Response;
    try {
      response = await fetch(
        `${this.serverUrl}/api/workflows/${encodeURIComponent(this.workflowName)}/files?${query.toString()}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": input.mimeType ?? "application/octet-stream",
          },
          body: normalizeCreateFileBody(input.buffer),
        },
      );
    } catch (error) {
      throw new WorkflowError({
        type: "workflow_execution",
        message: `Workflow file creation could not connect to server storage at ${this.serverUrl}. Check the App server connection or WORKFLOW_SERVER_URL/WORKFLOW_SERVER_ADMIN_KEY.`,
        metadata: {
          serverUrl: this.serverUrl,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }

    const payload = await readApiResponse<WorkflowFileReference[]>(response);
    if (!response.ok || payload.errCode !== 0) {
      throw new WorkflowError({
        type: "workflow_execution",
        message: payload.errMessage || `Workflow file creation failed with HTTP ${response.status}.`,
        metadata: {
          serverUrl: this.serverUrl,
          status: response.status,
          errCode: payload.errCode,
        },
      });
    }

    const reference = payload.data?.[0];
    if (reference === undefined) {
      throw new WorkflowError({
        type: "workflow_execution",
        message: "Workflow file creation server did not return a file reference.",
        metadata: {
          serverUrl: this.serverUrl,
        },
      });
    }

    return normalizeWorkflowFileReference({
      ...reference,
      url: reference.url ?? `/api/workflows/files/${encodeURIComponent(reference.id)}`,
    });
  }
}

export function createRemoteWorkflowFileStoreFromEnv(options: {
  env?: NodeJS.ProcessEnv;
  workflowName: string;
  conversationId?: string;
}): WorkflowFileStore | undefined {
  const env = options.env ?? process.env;
  const explicitServerUrl = env.WORKFLOW_FILE_SERVER_URL ?? env.WORKFLOW_SERVER_URL;
  const explicitToken =
    env.WORKFLOW_FILE_SERVER_TOKEN ??
    env.WORKFLOW_SERVER_ADMIN_KEY;
  const serverUrl = explicitServerUrl?.trim();
  const token = explicitToken?.trim();

  if (serverUrl !== undefined && serverUrl !== "" && token !== undefined && token !== "") {
    return new RemoteWorkflowFileStore({
      serverUrl,
      token,
      workflowName: options.workflowName,
      conversationId: options.conversationId,
    });
  }

  const authConfig = readWorkflowCliAuthConfigSync(env);
  if (authConfig.serverUrl.trim() === "" || authConfig.apiKey.trim() === "") {
    return undefined;
  }

  return new RemoteWorkflowFileStore({
    serverUrl: authConfig.serverUrl,
    token: authConfig.apiKey,
    workflowName: options.workflowName,
    conversationId: options.conversationId,
  });
}

async function readApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  try {
    const payload = await response.json() as unknown;
    if (
      isRecord(payload) &&
      typeof payload["errCode"] === "number" &&
      typeof payload["errMessage"] === "string"
    ) {
      return payload as unknown as ApiResponse<T>;
    }
  } catch {
    // handled below
  }

  return {
    errCode: response.status,
    errMessage: `Workflow file creation server returned HTTP ${response.status}.`,
  };
}

function normalizeCreateFileBody(value: WorkflowCreateFileInput["buffer"]): BodyInit {
  if (typeof value === "string" || value instanceof ArrayBuffer) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value as unknown as BodyInit;
  }
  return Buffer.from(value) as unknown as BodyInit;
}

function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
