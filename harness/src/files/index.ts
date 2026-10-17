import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WorkflowError } from "../workflow/errors";

const DEFAULT_STEAMHARNESS_CREATED_FILE_LIMIT_BYTES = 50 * 1024 * 1024;

export type WorkflowFileStorage = "local" | "server" | "path" | "url";

export type WorkflowFileKind = "image" | "file";

export interface WorkflowFileReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: WorkflowFileKind;
  storage: WorkflowFileStorage;
  workflowId?: string;
  conversationId?: string;
  createdAt: string;
  url?: string;
  path?: string;
}

export interface WorkflowResolvedFile extends WorkflowFileReference {
  readBuffer(): Promise<Buffer>;
  readBase64(): Promise<string>;
  readDataUrl(): Promise<string>;
  toLLMImagePart(): Promise<{
    type: "image";
    image: string;
    mediaType: string;
  }>;
  toJSON(): WorkflowFileReference;
}

export interface WorkflowCreateFileInput {
  name: string;
  mimeType?: string;
  buffer: Buffer | Uint8Array | ArrayBuffer | string;
  kind?: WorkflowFileKind;
  conversationId?: string;
}

export interface WorkflowFileStore {
  resolveFile(reference: WorkflowFileReference): Promise<WorkflowResolvedFile>;
  createFile?(input: WorkflowCreateFileInput): Promise<WorkflowFileReference>;
}

export type WorkflowFileCreator = (input: WorkflowCreateFileInput) => Promise<WorkflowFileReference>;

export interface LocalWorkflowFileStoreOptions {
  rootDir?: string;
  allowAbsolutePaths?: boolean;
}

export interface ServerWorkflowFileStoreOptions {
  rootDir: string;
  workflowName: string;
  conversationId?: string;
  maxBytes?: number;
}

export function createLocalWorkflowFileStore(
  options: LocalWorkflowFileStoreOptions = {},
): WorkflowFileStore {
  return {
    async resolveFile(reference) {
      const filePath = resolveReferencePath(reference, options);
      const info = await stat(filePath).catch((error) => {
        throw new WorkflowError({
          type: "input_validation",
          message: `Workflow file "${reference.name || reference.id}" does not exist.`,
          metadata: {
            fileId: reference.id,
          },
          cause: error,
        });
      });

      if (!info.isFile()) {
        throw new WorkflowError({
          type: "input_validation",
          message: `Workflow file "${reference.name || reference.id}" is not a file.`,
          metadata: {
            fileId: reference.id,
          },
        });
      }

      const normalized = normalizeWorkflowFileReference({
        ...reference,
        size: reference.size || info.size,
      });

      return createResolvedWorkflowFile(normalized, async () => readFile(filePath));
    },
  };
}

export function createWorkflowFileStore(options: {
  resolveStore?: WorkflowFileStore;
  createFile?: WorkflowFileCreator;
}): WorkflowFileStore {
  const resolveStore = options.resolveStore ?? createLocalWorkflowFileStore({ allowAbsolutePaths: true });

  return {
    resolveFile(reference) {
      return resolveStore.resolveFile(reference);
    },
    async createFile(input) {
      if (options.createFile === undefined) {
        throw createWorkflowFileCreateUnavailableError();
      }

      return normalizeWorkflowFileReference(await options.createFile(input));
    },
  };
}

export function createServerWorkflowFileStore(
  options: ServerWorkflowFileStoreOptions,
): WorkflowFileStore {
  const resolveStore = createLocalWorkflowFileStore({
    rootDir: options.rootDir,
    allowAbsolutePaths: true,
  });

  return createWorkflowFileStore({
    resolveStore,
    // This explicit store writes generated files to the server-managed namespace.
    async createFile(input) {
      const buffer = normalizeCreateFileBuffer(input.buffer);
      const maxBytes = options.maxBytes ?? DEFAULT_STEAMHARNESS_CREATED_FILE_LIMIT_BYTES;
      if (buffer.byteLength > maxBytes) {
        throw new WorkflowError({
          type: "input_validation",
          message: `Workflow file "${input.name}" exceeds ${formatBytes(maxBytes)} limit.`,
          metadata: {
            size: buffer.byteLength,
            maxBytes,
          },
        });
      }

      const id = createWorkflowManagedFileId();
      const name = normalizeCreatedFileName(input.name);
      const mimeType = normalizeCreatedFileMimeType(input.mimeType, name);
      const reference: WorkflowFileReference = {
        id,
        name,
        mimeType,
        size: buffer.byteLength,
        kind: input.kind ?? (mimeType.startsWith("image/") ? "image" : "file"),
        storage: "server",
        workflowId: options.workflowName,
        conversationId: readNonEmptyString(input.conversationId) ?? readNonEmptyString(options.conversationId),
        createdAt: new Date().toISOString(),
        url: `/api/workflows/files/${encodeURIComponent(id)}`,
      };
      const dir = path.join(options.rootDir, id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "content"), buffer);
      await writeFile(path.join(dir, "metadata.json"), `${JSON.stringify(reference, null, 2)}\n`, "utf8");

      return reference;
    },
  });
}

export function createResolvedWorkflowFile(
  reference: WorkflowFileReference,
  readBuffer: () => Promise<Buffer>,
): WorkflowResolvedFile {
  const normalized = normalizeWorkflowFileReference(reference);

  return {
    ...normalized,
    readBuffer,
    async readBase64() {
      return (await readBuffer()).toString("base64");
    },
    async readDataUrl() {
      const base64 = await this.readBase64();
      return `data:${normalized.mimeType || "application/octet-stream"};base64,${base64}`;
    },
    async toLLMImagePart() {
      if (normalized.kind !== "image" && !normalized.mimeType.startsWith("image/")) {
        throw new WorkflowError({
          type: "input_validation",
          message: `Workflow file "${normalized.name}" is not an image.`,
          metadata: {
            fileId: normalized.id,
            mimeType: normalized.mimeType,
          },
        });
      }

      return {
        type: "image" as const,
        image: await this.readDataUrl(),
        mediaType: normalized.mimeType,
      };
    },
    toJSON() {
      return normalized;
    },
  };
}

export function normalizeWorkflowFileReference(value: unknown): WorkflowFileReference {
  if (!isRecord(value)) {
    throw createInvalidFileReferenceError();
  }

  const id = readNonEmptyString(value.id);
  const mimeType = readNonEmptyString(value.mimeType) ?? "application/octet-stream";
  const size = typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0
    ? Math.round(value.size)
    : 0;
  const createdAt = readNonEmptyString(value.createdAt) ?? new Date().toISOString();
  const workflowId = readNonEmptyString(value.workflowId);
  const conversationId = readNonEmptyString(value.conversationId);
  const url = readNonEmptyString(value.url);
  const storage = readWorkflowFileStorage(value.storage, url);
  const kind = readWorkflowFileKind(value.kind, mimeType);
  const filePath = readNonEmptyString(value.path);

  if (id === undefined) {
    throw createInvalidFileReferenceError();
  }
  const name = readNonEmptyString(value.name) ?? id;

  return {
    id,
    name,
    mimeType,
    size,
    kind,
    storage,
    workflowId,
    conversationId,
    createdAt,
    url,
    path: filePath,
  };
}

export function parseWorkflowFileReferences(value: unknown): WorkflowFileReference[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return [];
    }

    const parsed = parseMaybeJson(trimmed);
    if (parsed !== undefined) {
      return parseWorkflowFileReferences(parsed);
    }

    return [createPathWorkflowFileReference(trimmed)];
  }

  if (Array.isArray(value)) {
    return value.map(normalizeWorkflowFileReference);
  }

  return [normalizeWorkflowFileReference(value)];
}

function createPathWorkflowFileReference(filePath: string): WorkflowFileReference {
  return {
    id: filePath,
    name: path.basename(filePath),
    mimeType: guessMimeType(filePath),
    size: 0,
    kind: guessMimeType(filePath).startsWith("image/") ? "image" : "file",
    storage: "path",
    path: filePath,
    createdAt: new Date().toISOString(),
  };
}

function resolveReferencePath(
  reference: WorkflowFileReference,
  options: LocalWorkflowFileStoreOptions,
): string {
  if (reference.storage === "url") {
    throw new WorkflowError({
      type: "input_validation",
      message: "URL workflow files cannot be read by the local file store.",
      metadata: {
        fileId: reference.id,
      },
    });
  }

  if (reference.storage === "path" || reference.path !== undefined) {
    const filePath = reference.path ?? reference.id;
    if (!path.isAbsolute(filePath) && options.rootDir !== undefined) {
      return path.resolve(options.rootDir, filePath);
    }
    if (!path.isAbsolute(filePath) || options.allowAbsolutePaths === true) {
      return filePath;
    }
    throw new WorkflowError({
      type: "input_validation",
      message: "Absolute workflow file paths are not enabled for this runtime.",
      metadata: {
        fileId: reference.id,
      },
    });
  }

  if (options.rootDir === undefined) {
    throw new WorkflowError({
      type: "input_validation",
      message: "Workflow file store root is not configured.",
      metadata: {
        fileId: reference.id,
      },
    });
  }

  return path.join(options.rootDir, reference.id, "content");
}

function parseMaybeJson(value: string): unknown | undefined {
  if (!value.startsWith("{") && !value.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readWorkflowFileStorage(value: unknown, url?: string): WorkflowFileStorage {
  if (value === "local" || value === "server" || value === "path" || value === "url") {
    return value;
  }

  if (url !== undefined) {
    return "url";
  }

  return "path";
}

function readWorkflowFileKind(value: unknown, mimeType: string): WorkflowFileKind {
  if (value === "image" || value === "file") {
    return value;
  }

  return mimeType.startsWith("image/") ? "image" : "file";
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function createInvalidFileReferenceError(): WorkflowError {
  return new WorkflowError({
    type: "input_validation",
    message: "Workflow file reference must be an object with a non-empty id.",
  });
}

export function createWorkflowFileCreateUnavailableError(): WorkflowError {
  return new WorkflowError({
    type: "workflow_execution",
    message: "Workflow file creation requires a configured file store. Connect the local host to server file storage or inject a workflow file creator.",
  });
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json";
    case ".txt":
    case ".md":
      return "text/plain";
    case ".wav":
      return "audio/wav";
    case ".aif":
    case ".aiff":
      return "audio/aiff";
    case ".flac":
      return "audio/flac";
    case ".alac":
      return "audio/alac";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".aac":
      return "audio/aac";
    case ".opus":
      return "audio/ogg";
    case ".ogg":
      return "audio/ogg";
    case ".webm":
      return "video/webm";
    case ".mp4":
      return "video/mp4";
    case ".m4v":
      return "video/x-m4v";
    case ".mov":
      return "video/quicktime";
    case ".avi":
      return "video/x-msvideo";
    case ".mkv":
      return "video/x-matroska";
    case ".ogv":
      return "video/ogg";
    case ".mpg":
    case ".mpeg":
      return "video/mpeg";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function normalizeCreateFileBuffer(value: WorkflowCreateFileInput["buffer"]): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return Buffer.from(value);
}

function createWorkflowManagedFileId(): string {
  return `wf_${randomUUID().replaceAll("-", "")}`;
}

function normalizeCreatedFileName(value: string): string {
  const name = path.basename(value.trim() || "file");
  return name.length > 180 ? name.slice(0, 180) : name;
}

function normalizeCreatedFileMimeType(value: string | undefined, fileName: string): string {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return normalized && normalized !== "application/octet-stream"
    ? normalized
    : guessMimeType(fileName);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${Math.round(value / (1024 * 1024))}MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)}KB`;
  }
  return `${value}B`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workflowFileReferenceToDataUrl(reference: WorkflowFileReference): string | undefined {
  if (reference.url?.startsWith("data:")) {
    return reference.url;
  }

  return undefined;
}

export function workflowFileReferenceToUrl(reference: WorkflowFileReference): URL | undefined {
  if (reference.url === undefined) {
    return undefined;
  }

  try {
    return new URL(reference.url);
  } catch {
    return pathToFileURL(reference.url);
  }
}
