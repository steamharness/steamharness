import pg from "pg";

const { Pool } = pg;

export interface CreatePostgresPoolOptions extends pg.PoolConfig {
  label: string;
}

export interface CreatePostgresClientOptions extends pg.ClientConfig {
  label: string;
}

export function createPostgresClient(options: CreatePostgresClientOptions): pg.Client {
  const { label, ...clientOptions } = options;
  const client = new pg.Client(clientOptions);
  client.on("error", (error) => {
    console.warn(formatPostgresClientError(label, error));
  });
  return client;
}

export function createPostgresPool(options: CreatePostgresPoolOptions, env: NodeJS.ProcessEnv = process.env): pg.Pool {
  const { label, ...poolOptions } = options;
  const rawMax = env.STEAMHARNESS_SERVER_DATABASE_POOL_MAX?.trim();
  const configuredMax = rawMax ? Number(rawMax) : undefined;
  if (configuredMax !== undefined && (!Number.isSafeInteger(configuredMax) || configuredMax < 1)) {
    throw new Error("STEAMHARNESS_SERVER_DATABASE_POOL_MAX must be a positive integer.");
  }
  const pool = new Pool({ ...poolOptions, ...(poolOptions.max === undefined && configuredMax !== undefined ? { max: configuredMax } : {}) });

  // pg-pool removes its idle error listener while a client is checked out.
  // Queries still reject on disconnect; also consume the asynchronous Client
  // event, including between queries or while holding an advisory lock.
  const onClientError = (error: Error) => {
    console.warn(formatPostgresClientError(label, error));
  };
  pool.on("acquire", (client) => client.on("error", onClientError));
  pool.on("release", (_error, client) => client.removeListener("error", onClientError));

  // PostgreSQL can terminate an idle client asynchronously; pg-pool
  // emits that on the Pool, so consume it here and let later queries reconnect.
  pool.on("error", (error) => {
    console.warn(formatPostgresPoolError(label, error));
  });

  return pool;
}

/**
 * PostgreSQL failures that mean the connection, not the statement, was
 * interrupted: the network dropped the socket, the server refused it, or the
 * handshake timed out. The statement never committed, so retrying is safe.
 */
const TRANSIENT_POSTGRES_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * A pooled client can be reset before or between queries, including while a
 * migration holds an advisory lock. Statement-level errors such as a constraint
 * violation (SQLSTATE 23xxx) or a syntax error (42xxx) are not transient and
 * must still surface, so this only matches connection loss.
 */
export function isTransientPostgresError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && (TRANSIENT_POSTGRES_CODES.has(code) || /^(08|57P0[123])/.test(code))) return true;
    if (/timeout expired|Connection terminated (unexpectedly|due to connection timeout)|Connection reset by peer/.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Startup schema work opens a fresh connection before any request is served. A
 * flaky link to a remote database drops a fraction of those handshakes, and a
 * single drop used to abort the whole boot. Initialization is idempotent
 * (`create ... if not exists`, checksum-guarded migrations), so retry only
 * transient connection failures a bounded number of times.
 */
export async function retryTransientPostgres<T>(work: () => Promise<T>, options: { label: string; attempts?: number }): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isTransientPostgresError(error)) throw error;
      const waitMs = 250 * attempt;
      console.warn(`[steamharness-server] ${options.label} PostgreSQL connection was interrupted during initialization; retrying in ${waitMs}ms (attempt ${attempt}/${attempts}).`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

export function formatPostgresPoolError(label: string, error: unknown): string {
  return formatPostgresError(label, "idle client error; future queries will reconnect.", error);
}

function formatPostgresClientError(label: string, error: unknown): string {
  return formatPostgresError(label, "client connection error; the current operation may fail.", error);
}

function formatPostgresError(label: string, message: string, error: unknown): string {
  const details = readPostgresErrorDetails(error);
  const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";

  return `[steamharness-server] ${label} PostgreSQL ${message}${suffix}`;
}

function readPostgresErrorDetails(error: unknown): string[] {
  if (!(error instanceof Error)) {
    return [String(error)];
  }

  const details = [error.message];
  const postgresError = error as Partial<{
    code: string;
    severity: string;
  }>;

  if (postgresError.code !== undefined) {
    details.push(`code=${postgresError.code}`);
  }

  if (postgresError.severity !== undefined) {
    details.push(`severity=${postgresError.severity}`);
  }

  return details;
}
