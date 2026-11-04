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
