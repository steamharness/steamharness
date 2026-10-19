import { readProjectCliAuthConfigSync } from "../auth-config";
import {
  normalizeProjectKVStoreInput,
  type NormalizedProjectKVStoreInput,
  type KVStore,
  type KVStoreGetInput,
  type KVNamespaceLockInput,
  type KVNamespaceMutation,
  type KVStoreSetInput,
  type KVWriteSource,
  type StorageKind,
} from "./index";
import { HarnessError } from "../workflow/errors";

interface ApiResponse<T> {
  errCode: number;
  errMessage: string;
  data?: T;
}

interface RemoteProjectStorageGetResult {
  exists: boolean;
  value?: unknown;
  revision?: string;
}

interface RemoteProjectStorageCompareAndSetResult {
  applied: boolean;
  revision?: string;
}

interface RemoteProjectStorageDeleteResult {
  removed: boolean;
}

const REMOTE_STEAMHARNESS_STORAGE_UPDATE_MAX_ATTEMPTS = 8;

export interface RemoteProjectStorageStoreOptions {
  serverUrl: string;
  token: string;
  projectId: string;
  storageKind: StorageKind;
  relatedProject?: {
    consumerProjectId: string;
    alias: string;
  };
}

export class RemoteProjectStorageStore implements KVStore {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly projectId: string;
  private readonly storageKind: StorageKind;
  private readonly relatedProject: RemoteProjectStorageStoreOptions["relatedProject"];

  constructor(options: RemoteProjectStorageStoreOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.token = options.token.trim();
    this.projectId = options.projectId.trim();
    this.storageKind = options.storageKind;
    this.relatedProject = options.relatedProject === undefined
      ? undefined
      : {
          consumerProjectId: options.relatedProject.consumerProjectId.trim(),
          alias: options.relatedProject.alias.trim(),
        };
  }

  async getValue(input: KVStoreGetInput): Promise<unknown | undefined> {
    const response = await this.getStorageEntry(input);
    return response.exists ? response.value : undefined;
  }

  async setValue(input: KVStoreSetInput): Promise<void> {
    assertRemoteProjectStorageValue(input.value);
    await this.fetchStorage<void>({
      method: "POST",
      body: {
        operation: "set",
        entry: this.createStorageEntry(input),
        value: input.value,
        source: input.source,
      },
    });
  }

  async deleteValue(input: KVStoreGetInput): Promise<boolean> {
    const result = await this.fetchStorage<RemoteProjectStorageDeleteResult>({
      method: "POST",
      body: {
        operation: "delete",
        entry: this.createStorageEntry(input),
      },
    });
    if (typeof result.removed !== "boolean") {
      throw createRemoteProjectStorageProtocolError(
        "Workflow storage server returned an invalid delete result.",
      );
    }
    return result.removed;
  }

  async updateValue(
    input: KVStoreGetInput & { source?: KVWriteSource },
    updater: (current: unknown | undefined) => unknown,
  ): Promise<unknown> {
    const entry = this.createStorageEntry(input);
    for (let attempt = 0; attempt < REMOTE_STEAMHARNESS_STORAGE_UPDATE_MAX_ATTEMPTS; attempt += 1) {
      const current = await this.getStorageEntry(input);
      if (current.exists && typeof current.revision !== "string") {
        throw createRemoteProjectStorageProtocolError(
          "Workflow storage server did not return a revision for an existing value.",
        );
      }

      const value = updater(current.exists ? current.value : undefined);
      assertRemoteProjectStorageValue(value);
      const result = await this.fetchStorage<RemoteProjectStorageCompareAndSetResult>({
        method: "POST",
        body: {
          operation: "compare-and-set",
          entry,
          expectedRevision: current.exists ? current.revision : null,
          value,
          source: input.source,
        },
      });
      if (result.applied === true) {
        return value;
      }
      if (result.applied !== false) {
        throw createRemoteProjectStorageProtocolError(
          "Workflow storage server returned an invalid compare-and-set result.",
        );
      }
    }

    throw new HarnessError({
      type: "execution",
      message: "Workflow storage update could not complete because the value kept changing concurrently.",
      metadata: {
        serverUrl: this.serverUrl,
        maxAttempts: REMOTE_STEAMHARNESS_STORAGE_UPDATE_MAX_ATTEMPTS,
      },
    });
  }

  async executeNamespaceMutation<T>(
    input: KVNamespaceLockInput,
    mutation: KVNamespaceMutation,
  ): Promise<T> {
    return this.fetchStorage<T>({
      method: "POST",
      body: {
        operation: "knowledge-mutation",
        namespace: this.createStorageNamespace(input),
        mutation: createRemoteProjectStorageKnowledgeMutation(mutation),
      },
    });
  }

  private async fetchStorage<T>(options: {
    method: "POST";
    body: Record<string, unknown>;
  }): Promise<T> {
    if (
      this.serverUrl === "" ||
      this.token === "" ||
      this.projectId === "" ||
      (this.relatedProject !== undefined && (
        this.relatedProject.consumerProjectId === "" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(this.relatedProject.alias)
      ))
    ) {
      throw createRemoteProjectStorageConfigError();
    }

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/project-storage`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...this.createRequestAddress(),
          storageKind: this.storageKind,
          ...options.body,
        }),
      });
    } catch (error) {
      throw new HarnessError({
        type: "execution",
        message: `Workflow project storage could not connect to server database storage at ${this.serverUrl}. Check STEAMHARNESS_SERVER_URL/STEAMHARNESS_SERVER_ADMIN_KEY or Desktop server connection settings.`,
        metadata: {
          serverUrl: this.serverUrl,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }

    const payload = await readApiResponse<T>(response);
    if (response.ok && payload.errCode === 0) {
      return payload.data as T;
    }

    throw new HarnessError({
      type: "execution",
      message: payload.errMessage || `Workflow project storage failed with HTTP ${response.status}.`,
      metadata: {
        serverUrl: this.serverUrl,
        status: response.status,
        errCode: payload.errCode,
        data: payload.data,
      },
    });
  }

  private async getStorageEntry(input: KVStoreGetInput): Promise<RemoteProjectStorageGetResult> {
    const response = await this.fetchStorage<RemoteProjectStorageGetResult>({
      method: "POST",
      body: {
        operation: "get",
        entry: this.createStorageEntry(input),
      },
    });
    if (typeof response.exists !== "boolean") {
      throw createRemoteProjectStorageProtocolError(
        "Workflow storage server returned an invalid get result.",
      );
    }
    return response;
  }

  private createStorageEntry(input: KVStoreGetInput) {
    const entry = createRemoteProjectStorageEntry(input);
    this.assertBoundInput(entry);
    if (this.relatedProject === undefined) return entry;
    const { projectId: _targetProjectId, ...relatedEntry } = entry;
    return relatedEntry;
  }

  private createStorageNamespace(input: KVNamespaceLockInput) {
    const namespace = createRemoteProjectStorageNamespace(input);
    this.assertBoundInput(namespace);
    if (this.relatedProject === undefined) return namespace;
    const { projectId: _targetProjectId, ...relatedNamespace } = namespace;
    return relatedNamespace;
  }

  private createRequestAddress():
    | { projectId: string }
    | { consumerProjectId: string; alias: string } {
    return this.relatedProject === undefined
      ? { projectId: this.projectId }
      : { ...this.relatedProject };
  }

  private assertBoundInput(input: { storageKind: StorageKind; projectId: string }): void {
    if (input.storageKind !== this.storageKind || input.projectId !== this.projectId) {
      throw new HarnessError({
        type: "input_validation",
        message: "Workflow project storage input does not match the bound project and storage kind.",
      });
    }
  }
}

export function createRemoteProjectStorageStoreFromEnv(
  projectId: string,
  storageKind: StorageKind,
  env: NodeJS.ProcessEnv = process.env,
): KVStore | undefined {
  return createRemoteProjectStorageStoreFromConnection({
    projectId,
    storageKind,
  }, env);
}

export function createRemoteProjectRelatedProjectKVStoreFromEnv(options: {
  consumerProjectId: string;
  targetProjectId: string;
  alias: string;
  env?: NodeJS.ProcessEnv;
}): KVStore | undefined {
  return createRemoteProjectStorageStoreFromConnection({
    projectId: options.targetProjectId,
    storageKind: "kv",
    relatedProject: {
      consumerProjectId: options.consumerProjectId,
      alias: options.alias,
    },
  }, options.env ?? process.env);
}

function createRemoteProjectStorageStoreFromConnection(
  options: Omit<RemoteProjectStorageStoreOptions, "serverUrl" | "token">,
  env: NodeJS.ProcessEnv,
): KVStore | undefined {
  const explicitServerUrl = env.STEAMHARNESS_SERVER_URL;
  const explicitToken = env.STEAMHARNESS_SERVER_ADMIN_KEY;
  const serverUrl = explicitServerUrl?.trim();
  const token = explicitToken?.trim();

  if (serverUrl !== undefined && serverUrl !== "" && token !== undefined && token !== "") {
    return new RemoteProjectStorageStore({ serverUrl, token, ...options });
  }

  const authConfig = readProjectCliAuthConfigSync(env);
  if (authConfig.serverUrl.trim() !== "" && authConfig.apiKey.trim() !== "") {
    return new RemoteProjectStorageStore({
      serverUrl: authConfig.serverUrl,
      token: authConfig.apiKey,
      ...options,
    });
  }

  return undefined;
}

function createRemoteProjectStorageEntry(input: KVStoreGetInput): {
  storageKind: StorageKind;
  scope: NormalizedProjectKVStoreInput["scope"];
  projectId: string;
  key: string;
  conversationId?: string;
} {
  const normalized = normalizeProjectKVStoreInput(input);
  return normalized.scope === "project"
    ? {
        storageKind: normalized.storageKind,
        scope: normalized.scope,
        projectId: normalized.projectId,
        key: normalized.key,
      }
    : {
        storageKind: normalized.storageKind,
        scope: normalized.scope,
        projectId: normalized.projectId,
        conversationId: normalized.conversationId,
        key: normalized.key,
      };
}

function createRemoteProjectStorageNamespace(input: KVNamespaceLockInput): {
  storageKind: StorageKind;
  scope: NormalizedProjectKVStoreInput["scope"];
  projectId: string;
  conversationId?: string;
} {
  const normalized = normalizeProjectKVStoreInput({
    ...input,
    key: "namespace-mutation",
  });
  return normalized.scope === "project"
    ? {
        storageKind: normalized.storageKind,
        scope: normalized.scope,
        projectId: normalized.projectId,
      }
    : {
        storageKind: normalized.storageKind,
        scope: normalized.scope,
        projectId: normalized.projectId,
        conversationId: normalized.conversationId,
      };
}

/**
 * The Runtime API's knowledge-mutation vocabulary, for any host store that
 * executes mutations the way this one does.
 *
 * This module's own helpers name their mutations `knowledge-document.*`; the
 * Runtime API takes `create`/`edit`/`delete` with the document id spelled
 * `documentId`. A host that forwards the mutation verbatim (rather than
 * routing it through `RemoteProjectStorageStore`) has to translate it here
 * first, or the server rejects the request as malformed.
 */
export function createRemoteProjectStorageKnowledgeMutation(
  mutation: KVNamespaceMutation,
): { type: "create" | "edit" | "delete"; input: unknown } {
  switch (mutation.type) {
    case "knowledge-document.create":
      return { type: "create", input: mutation.input };
    case "knowledge-document.edit": {
      const input = mutation.input;
      return {
        type: "edit",
        input: isRecord(input)
          ? {
              documentId: input["id"],
              title: input["title"],
              markdown: input["markdown"],
            }
          : input,
      };
    }
    case "knowledge-document.delete":
      return { type: "delete", input: mutation.input };
    default:
      throw new HarnessError({
        type: "input_validation",
        message: `Remote Workflow storage does not support namespace mutation "${mutation.type}".`,
        metadata: { mutationType: mutation.type },
      });
  }
}

async function readApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  try {
    const payload = await response.json() as ApiResponse<T>;
    return isApiResponse(payload)
      ? payload
      : { errCode: response.status, errMessage: "Workflow storage server returned an invalid response." };
  } catch {
    return {
      errCode: response.status,
      errMessage: `Workflow storage server returned HTTP ${response.status}.`,
    };
  }
}

function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function createRemoteProjectStorageConfigError(): HarnessError {
  return new HarnessError({
    type: "input_validation",
    message: "Server storage requires a project id and an authenticated server connection. Sign in and bind this project to the same server project id before accessing context.storage.server.",
  });
}

function createRemoteProjectStorageProtocolError(message: string): HarnessError {
  return new HarnessError({
    type: "execution",
    message,
  });
}

function assertRemoteProjectStorageValue(value: unknown): void {
  if (value === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: "Workflow KV value cannot be undefined.",
    });
  }
}

function isApiResponse<T>(value: unknown): value is ApiResponse<T> {
  return isRecord(value) &&
    typeof value["errCode"] === "number" &&
    typeof value["errMessage"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
