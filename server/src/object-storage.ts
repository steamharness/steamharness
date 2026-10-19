/**
 * Storage-backend-agnostic object storage contract.
 *
 * Every consumer talks to this interface instead of a concrete backend, so
 * version publishing, project files and avatars never name a concrete store.
 *
 * This module intentionally imports nothing: it is the leaf that both the
 * backend and their callers depend on, which keeps the not-found predicate free
 * of a transitive transport dependency.
 */

export type StorageDriver = "local";

export interface ObjectStorage {
  readonly driver: StorageDriver;
  /** Origin that object URLs are minted from. */
  readonly publicBaseUrl: string;
  objectKey(logicalPath: string): string;
  publicUrl(logicalPath: string): string;
  uploadBuffer(logicalPath: string, buffer: Buffer, contentType: string): Promise<string>;
  uploadPrivateBuffer(logicalPath: string, buffer: Buffer, contentType?: string): Promise<void>;
  uploadPrivateFile(logicalPath: string, filePath: string, contentType?: string): Promise<void>;
  downloadPrivateBuffer(logicalPath: string): Promise<Buffer>;
  downloadPrivateFile(logicalPath: string, filePath: string): Promise<void>;
  assertPrivateObject(logicalPath: string): Promise<void>;
  /**
   * Return a short-lived signed URL when the backend can mint one, or `undefined`
   * when it cannot. Callers must treat `undefined` as "serve this through the
   * Server's own capability-checked endpoint" rather than as a failure.
   */
  privateDownloadUrl(logicalPath: string, expiresSeconds?: number): string | undefined;
}

/**
 * True when an object is missing. This predicate gates the 404-vs-500 distinction
 * for artifact reads, so the backend must throw an error it recognizes: a missing
 * artifact reported as 500 would look like a server fault to every caller.
 */
export function isProjectStorageNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const record = error as Error & { status?: number; statusCode?: number; code?: string };
  return record.status === 404
    || record.statusCode === 404
    || record.code === "NoSuchKey"
    || /not found|no such key|http 404/iu.test(record.message);
}
