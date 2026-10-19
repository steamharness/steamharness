/**
 * Local-directory object storage backend (`STEAMHARNESS_STORAGE_DRIVER=local`).
 *
 * The `storage/` key prefix, the write-once handling of content-addressed keys,
 * the `NoSuchKey` not-found shape and a `privateDownloadUrl` of `undefined` are the
 * contract this backend presents to its callers, not incidental choices so private transfers fall back to the Server's own
 * capability-checked endpoint instead of a signed URL.
 */
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ObjectStorage } from "./object-storage";
import { HttpError } from "./protocol";
import {
  resolveLocalStoragePublicBaseUrl,
  resolveLocalStorageRootFromEnv,
} from "./storage-driver";

const OBJECT_PREFIX = "storage";
const PUBLIC_FILE_MODE = 0o644;
const PRIVATE_FILE_MODE = 0o600;

export const AVATAR_USER_ID_PATTERN = /^[a-f0-9-]{1,64}$/;
export const AVATAR_FILE_PATTERN = /^([a-f0-9]{64})\.(png|jpe?g|gif|webp)$/i;

const AVATAR_CONTENT_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export interface LocalStorageOptions {
  root: string;
  publicBaseUrl: string;
}

export interface LocalObjectAsset {
  filePath: string;
  size: number;
  contentType: string;
  hash: string;
}

export class LocalStorage implements ObjectStorage {
  readonly driver = "local" as const;
  readonly root: string;
  readonly prefix = OBJECT_PREFIX;
  readonly publicBaseUrl: string;

  constructor(options: LocalStorageOptions) {
    this.root = path.resolve(options.root);
    this.publicBaseUrl = options.publicBaseUrl;
  }

  objectKey(logicalPath: string): string {
    const normalized = logicalPath.replace(/^\/+|\/+$/gu, "");
    if (
      !normalized
      || normalized.includes("\\")
      || normalized.split("/").some((part) => !part || part === ".." || part === ".")
    ) {
      throw new Error("Object path is invalid.");
    }
    return `${OBJECT_PREFIX}/${normalized}`;
  }

  publicUrl(logicalPath: string): string {
    return new URL(encodeObjectKey(this.objectKey(logicalPath)), this.publicBaseUrl).toString();
  }

  async uploadBuffer(logicalPath: string, buffer: Buffer, _contentType: string): Promise<string> {
    // Bytes are written verbatim and the MIME type is discarded: the local backend serves every object with its own headers. The
    // public route currently serves only the avatar subtree and derives the response
    // content type from the extension, so a public object outside that subtree is
    // stored but not reachable over HTTP.
    await this.writeOnce(this.pathFor(logicalPath), async (temporaryPath) => {
      await writeFile(temporaryPath, buffer, { flag: "wx", mode: PUBLIC_FILE_MODE });
    });
    return this.publicUrl(logicalPath);
  }

  async uploadPrivateBuffer(
    logicalPath: string,
    buffer: Buffer,
    _contentType = "application/octet-stream",
  ): Promise<void> {
    await this.writeOnce(this.pathFor(logicalPath), async (temporaryPath) => {
      await writeFile(temporaryPath, buffer, { flag: "wx", mode: PRIVATE_FILE_MODE });
    });
  }

  async uploadPrivateFile(
    logicalPath: string,
    filePath: string,
    _contentType = "application/octet-stream",
  ): Promise<void> {
    await this.writeOnce(this.pathFor(logicalPath), async (temporaryPath) => {
      await pipeline(
        createReadStream(filePath),
        createWriteStream(temporaryPath, { flags: "wx", mode: PRIVATE_FILE_MODE }),
      );
    });
  }

  async downloadPrivateBuffer(logicalPath: string): Promise<Buffer> {
    return readFile(this.pathFor(logicalPath)).catch((error: unknown) => {
      throw toReadError(error, "Workflow local object was not found.");
    });
  }

  async assertPrivateObject(logicalPath: string): Promise<void> {
    const info = await stat(this.pathFor(logicalPath)).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      throw createObjectMissingError("Workflow local object was not found.");
    }
  }

  async downloadPrivateFile(logicalPath: string, filePath: string): Promise<void> {
    const source = this.pathFor(logicalPath);
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await pipeline(
        createReadStream(source),
        createWriteStream(filePath, { flags: "wx" }),
      );
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => undefined);
      throw toReadError(error, "Workflow local object was not found.");
    }
  }

  /**
   * The local driver cannot mint signed URLs. `undefined` tells the caller to serve
   * the object through the Server's capability-checked endpoint instead.
   */
  privateDownloadUrl(_logicalPath: string, _expiresSeconds = 300): string | undefined {
    return undefined;
  }

  /**
   * Resolve an avatar for the public `/storage/avatars/...` route. Public objects
   * are the only ones this route may serve, so this is intentionally the single
   * public-read entry point and lives on the class rather than on the interface —
   * `res.sendFile` needs a path, size and ETag, which only a local backend has.
   */
  async resolvePublicAvatar(userId: string, fileName: string): Promise<LocalObjectAsset> {
    const match = AVATAR_FILE_PATTERN.exec(fileName);
    if (!AVATAR_USER_ID_PATTERN.test(userId) || !match?.[1] || !match[2]) {
      throw createAvatarMissingError();
    }

    const filePath = this.pathFor(`avatars/${userId}/${fileName}`);
    // `lstat`, not `stat`: this is the only unauthenticated read path, and a symlink
    // is never something this store writes itself.
    const info = await lstat(filePath).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      throw createAvatarMissingError();
    }

    return {
      filePath,
      size: info.size,
      contentType: AVATAR_CONTENT_TYPES[match[2].toLowerCase()] ?? "application/octet-stream",
      hash: match[1],
    };
  }

  /** Absolute path of a logical object, with a containment assertion as defence in depth. */
  private pathFor(logicalPath: string): string {
    const resolved = path.resolve(this.root, this.objectKey(logicalPath));
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Object path escapes the storage root.");
    }
    return resolved;
  }

  /**
   * Object keys are content-addressed, so an existing target already holds these
   * exact bytes. Skipping the write keeps the backend write-once, where an
   * "already exists" upload is tolerated as success.
   */
  private async writeOnce(
    target: string,
    write: (temporaryPath: string) => Promise<void>,
  ): Promise<void> {
    const existing = await stat(target).catch(() => undefined);
    if (existing?.isFile()) {
      return;
    }

    await mkdir(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.${randomUUID()}.tmp`;
    try {
      await write(temporaryPath);
      await rename(temporaryPath, target).catch((error: NodeJS.ErrnoException) => {
        // A concurrent writer won the race; content-addressed keys mean it wrote
        // the same bytes.
        if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
      });
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export function isProjectLocalStorage(value: unknown): value is LocalStorage {
  return value instanceof LocalStorage;
}

/**
 * Always returns an instance or throws: an unusable root is a misconfiguration, so
 * it must fail at startup rather than at the first avatar upload.
 */
export function createProjectLocalStorageFromEnv(options: {
  env?: NodeJS.ProcessEnv;
  dataRoot: string;
}): LocalStorage {
  const env = options.env ?? process.env;
  const root = resolveLocalStorageRootFromEnv({ env, dataRoot: options.dataRoot });
  const publicBaseUrl = resolveLocalStoragePublicBaseUrl(env);

  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new Error(
      `Local object storage root ${root} is not usable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return new LocalStorage({ root, publicBaseUrl });
}

/**
 * Map a filesystem miss onto the backend-agnostic not-found shape. `status`/`code`
 * are what `isProjectStorageNotFoundError` reads, and that predicate gates the
 * 404-vs-500 distinction for artifact reads.
 */
function toReadError(error: unknown, message: string): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return createObjectMissingError(message);
  }
  return error;
}

function createObjectMissingError(message: string): Error {
  const missing = new Error(message) as Error & { status?: number; code?: string };
  missing.status = 404;
  missing.code = "NoSuchKey";
  return missing;
}

/**
 * Public reads are served straight to a client, so they need a real `HttpError` for
 * the error middleware to answer 404. The private paths keep the plain not-found
 * shape instead, because their callers translate it through
 * `isProjectStorageNotFoundError`.
 */
function createAvatarMissingError(): HttpError {
  return new HttpError(404, 404, "Avatar does not exist.");
}

function encodeObjectKey(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
