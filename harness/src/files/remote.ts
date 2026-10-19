import { readWorkflowCliAuthConfigSync } from "../auth-config";
import {
  createWorkflowFileStore,
  createWorkflowFileCreateUnavailableError,
  normalizeWorkflowFileReference,
  createResolvedWorkflowFile,
  type CreateFileInput,
  type FileReference,
  type FileStore,
} from "./index";
import { HarnessError } from "../workflow/errors";

interface ApiResponse<T> {
  errCode: number;
  errMessage: string;
  data?: T;
}

export interface RemoteWorkflowFileStoreOptions {
  serverUrl: string;
  token: string;
  projectName: string;
  conversationId?: string;
}

export class RemoteWorkflowFileStore implements FileStore {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly projectName: string;
  private readonly conversationId?: string;
  private readonly fallbackStore: FileStore;

  constructor(options: RemoteWorkflowFileStoreOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.token = options.token.trim();
    this.projectName = options.projectName;
    this.conversationId = options.conversationId;
    this.fallbackStore = createWorkflowFileStore({});
  }

  async resolveFile(reference: FileReference) {
    if (reference.storage !== "server") return this.fallbackStore.resolveFile(reference);
    const normalized = normalizeWorkflowFileReference(reference);
    if (normalized.projectId !== undefined && normalized.projectId !== this.projectName) {
      throw new HarnessError({ type: "input_validation", message: "Workflow file belongs to another project." });
    }
    if (this.serverUrl === "" || this.token === "") throw createWorkflowFileCreateUnavailableError();
    return createResolvedWorkflowFile(normalized, async () => {
      // Use the managed endpoint, never a caller-supplied URL or path with credentials.
      const response = await fetch(
        `${this.serverUrl}/api/projects/files/${encodeURIComponent(normalized.id)}`,
        { headers: { Authorization: `Bearer ${this.token}` }, redirect: "error" },
      );
      if (!response.ok) {
        const payload = await readApiResponse(response);
        throw new HarnessError({
          type: "workflow_execution",
          message: payload.errMessage || `Workflow file read failed with HTTP ${response.status}.`,
          metadata: { fileId: normalized.id, status: response.status },
        });
      }
      return Buffer.from(await response.arrayBuffer());
    });
  }

  async createFile(input: CreateFileInput): Promise<FileReference> {
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
        `${this.serverUrl}/api/projects/${encodeURIComponent(this.projectName)}/files?${query.toString()}`,
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
      throw new HarnessError({
        type: "workflow_execution",
        message: `Workflow file creation could not connect to server storage at ${this.serverUrl}. Check the App server connection or STEAMHARNESS_SERVER_URL/STEAMHARNESS_SERVER_ADMIN_KEY.`,
        metadata: {
          serverUrl: this.serverUrl,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }

    const payload = await readApiResponse<FileReference[]>(response);
    if (!response.ok || payload.errCode !== 0) {
      throw new HarnessError({
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
      throw new HarnessError({
        type: "workflow_execution",
        message: "Workflow file creation server did not return a file reference.",
        metadata: {
          serverUrl: this.serverUrl,
        },
      });
    }

    return normalizeWorkflowFileReference({
      ...reference,
      url: reference.url ?? `/api/projects/files/${encodeURIComponent(reference.id)}`,
    });
  }
}

export function createRemoteWorkflowFileStoreFromEnv(options: {
  env?: NodeJS.ProcessEnv;
  projectName: string;
  conversationId?: string;
}): FileStore | undefined {
  const env = options.env ?? process.env;
  const explicitServerUrl = env.STEAMHARNESS_FILE_SERVER_URL ?? env.STEAMHARNESS_SERVER_URL;
  const explicitToken =
    env.STEAMHARNESS_FILE_SERVER_TOKEN ??
    env.STEAMHARNESS_SERVER_ADMIN_KEY;
  const serverUrl = explicitServerUrl?.trim();
  const token = explicitToken?.trim();

  if (serverUrl !== undefined && serverUrl !== "" && token !== undefined && token !== "") {
    return new RemoteWorkflowFileStore({
      serverUrl,
      token,
      projectName: options.projectName,
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
    projectName: options.projectName,
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

function normalizeCreateFileBody(value: CreateFileInput["buffer"]): BodyInit {
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
