import pg from "pg";

const { Pool } = pg;

export interface CreatePostgresPoolOptions extends pg.PoolConfig {
  label: string;
}

export function createPostgresPool(options: CreatePostgresPoolOptions): pg.Pool {
  const { label, ...poolOptions } = options;
  const pool = new Pool(poolOptions);

  // PostgreSQL can terminate an idle client asynchronously; pg-pool
  // emits that on the Pool, so consume it here and let later queries reconnect.
  pool.on("error", (error) => {
    console.warn(formatPostgresPoolError(label, error));
  });

  return pool;
}

export function formatPostgresPoolError(label: string, error: unknown): string {
  const details = readPostgresErrorDetails(error);
  const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";

  return `[workflow-server] ${label} PostgreSQL idle client error; future queries will reconnect.${suffix}`;
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
