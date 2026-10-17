import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowMcpFileResolver,
  WorkflowMcpManagedFileReference,
} from "./types";
import { WorkflowMcpInvalidParamsError } from "./schema";

export const WORKFLOW_MCP_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export function createLocalWorkflowMcpFileResolver(options: {
  fileStoreDir: string;
  now?: () => Date;
  createId?: () => string;
  maxFileSizeBytes?: number;
}): WorkflowMcpFileResolver {
  const root = path.resolve(options.fileStoreDir);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? WORKFLOW_MCP_MAX_FILE_SIZE_BYTES;

  return async (values, context) => {
    const sources: Array<{ path: string; handle: Awaited<ReturnType<typeof open>>; size: number }> = [];
    const refs: WorkflowMcpManagedFileReference[] = [];
    const createdDirs: string[] = [];
    try {
      // Keep validated file handles open through the copy. A path-based lstat
      // followed by copyFile would allow the source to be swapped in between.
      for (const value of values) {
        if (typeof value !== "string" || !path.isAbsolute(value)) {
          throw new WorkflowMcpInvalidParamsError(
            `File parameter "${context.param.name}" only accepts absolute paths.`,
          );
        }
        throwIfAborted(context.signal);
        const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
        const handle = await open(value, constants.O_RDONLY | noFollow).catch(() => undefined);
        if (handle === undefined) {
          throw new WorkflowMcpInvalidParamsError(`File "${value}" does not exist or is not a regular file.`);
        }
        let valid = false;
        try {
          const info = await handle.stat();
          // On platforms without O_NOFOLLOW, check the pathname as well. The
          // opened descriptor remains tied to the object even if the path moves.
          const pathInfo = await lstat(value).catch(() => undefined);
          valid = info.isFile() && !pathInfo?.isSymbolicLink() && pathInfo?.isFile() === true;
          if (!valid) {
            throw new WorkflowMcpInvalidParamsError(`File "${value}" does not exist or is not a regular file.`);
          }
          if (info.size > maxFileSizeBytes) {
            throw new WorkflowMcpInvalidParamsError(`File "${path.basename(value)}" exceeds 50MB.`);
          }
          sources.push({ path: value, handle, size: info.size });
        } catch (error) {
          if (!sources.some((source) => source.handle === handle)) await handle.close().catch(() => undefined);
          throw error;
        }
      }

      await mkdir(root, { recursive: true });
      for (const source of sources) {
        throwIfAborted(context.signal);
        const id = options.createId?.() ?? `wf_${randomUUID().replaceAll("-", "")}`;
        if (!isSafeManagedFileId(id)) {
          throw new WorkflowMcpInvalidParamsError("Generated managed file id is invalid.");
        }
        const createdAt = (options.now?.() ?? new Date()).toISOString();
        const mimeType = guessMimeType(source.path);
        const targetDir = path.join(root, id);
        const temporaryContent = path.join(targetDir, "content.tmp");
        await mkdir(targetDir);
        createdDirs.push(targetDir);
        const copiedSize = await copyFileHandle(source.handle, temporaryContent, maxFileSizeBytes, context.signal, source.path);
        const metadata: WorkflowMcpManagedFileReference = {
          id,
          name: path.basename(source.path),
          mimeType,
          size: copiedSize,
          kind: mimeType.startsWith("image/") ? "image" : "file",
          storage: "local",
          workflowId: context.projectId,
          createdAt,
        };
        throwIfAborted(context.signal);
        await rename(temporaryContent, path.join(targetDir, "content"));
        await writeFile(path.join(targetDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        refs.push(metadata);
      }
      return refs;
    } catch (error) {
      await Promise.allSettled(createdDirs.map((directory) => rm(directory, { recursive: true, force: true })));
      throw error;
    } finally {
      await Promise.allSettled(sources.map((source) => source.handle.close()));
    }
  };
}

async function copyFileHandle(
  source: Awaited<ReturnType<typeof open>>,
  targetPath: string,
  maxFileSizeBytes: number,
  signal: AbortSignal,
  sourcePath: string,
): Promise<number> {
  const target = await open(targetPath, "wx");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxFileSizeBytes) {
        throw new WorkflowMcpInvalidParamsError(`File "${path.basename(sourcePath)}" exceeds 50MB.`);
      }
      let offset = 0;
      while (offset < bytesRead) {
        throwIfAborted(signal);
        const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, null);
        if (bytesWritten <= 0) throw new Error("Managed file copy made no progress.");
        offset += bytesWritten;
      }
    }
    return total;
  } finally {
    await target.close();
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new Error("Workflow MCP file import was cancelled.");
}

function isSafeManagedFileId(value: string): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    path.basename(value) === value &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

export function createServerWorkflowMcpFileResolver(options: {
  readFile(projectId: string, fileId: string): Promise<WorkflowMcpManagedFileReference | undefined>;
}): WorkflowMcpFileResolver {
  return async (values, context) => {
    const refs: WorkflowMcpManagedFileReference[] = [];
    for (const value of values) {
      if (context.signal.aborted) throw context.signal.reason;
      if (!isIdReference(value)) {
        throw new WorkflowMcpInvalidParamsError(
          `File parameter "${context.param.name}" only accepts an object containing id.`,
        );
      }
      const metadata = await options.readFile(context.projectId, value.id);
      if (
        !metadata ||
        metadata.id !== value.id ||
        metadata.storage !== "server" ||
        metadata.workflowId !== context.projectId
      ) {
        throw new WorkflowMcpInvalidParamsError(
          `File "${value.id}" does not belong to project "${context.projectId}".`,
        );
      }
      refs.push(normalizeAuthoritativeServerFile(metadata, context.projectId));
    }
    return refs;
  };
}

function isIdReference(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && typeof (value as { id?: unknown }).id === "string" &&
    (value as { id: string }).id.trim() !== "";
}

function normalizeAuthoritativeServerFile(
  metadata: WorkflowMcpManagedFileReference,
  projectId: string,
): WorkflowMcpManagedFileReference {
  return {
    id: metadata.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    size: metadata.size,
    kind: metadata.kind,
    storage: "server",
    workflowId: projectId,
    conversationId: metadata.conversationId,
    createdAt: metadata.createdAt,
  };
}

function guessMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json";
    case ".wav": return "audio/wav";
    case ".aif":
    case ".aiff": return "audio/aiff";
    case ".flac": return "audio/flac";
    case ".alac": return "audio/alac";
    case ".m4a": return "audio/mp4";
    case ".mp3": return "audio/mpeg";
    case ".aac": return "audio/aac";
    case ".ogg":
    case ".opus": return "audio/ogg";
    case ".webm": return "audio/webm";
    case ".pdf": return "application/pdf";
    case ".md": return "text/markdown";
    case ".txt": return "text/plain";
    case ".csv": return "text/csv";
    default: return "application/octet-stream";
  }
}
