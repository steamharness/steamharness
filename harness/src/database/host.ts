import { DatabaseResourceError, type DatabaseBinding, type DatabaseBindingIdentity, type DatabaseConsumerIdentity, type DatabaseAccessMode } from "./resources";
import { setTimeout as delay } from "node:timers/promises";

/** Native-host protocol. Credentials must never be forwarded to project RPC or a browser. */
export interface DatabaseConnectionRequest extends DatabaseConsumerIdentity {
  readonly schemaHash: string;
  readonly binding?: DatabaseBindingIdentity;
}
export interface DatabaseCredential {
  readonly id: string;
  readonly databaseId: string;
  readonly mode: DatabaseAccessMode;
  readonly revision: number;
  readonly schemaHash: string | null;
  readonly expiresAt: string;
  readonly connectionString: string;
}
export interface DatabaseConnectionLease {
  readonly binding: DatabaseBinding;
  readonly credential: DatabaseCredential;
}
export interface RelationalDatabaseHost {
  open(request: DatabaseConnectionRequest): Promise<DatabaseConnectionLease>;
  authorize(request: DatabaseConnectionRequest & { credentialId: string }): Promise<void>;
  release(credentialId: string): Promise<void>;
}

/** Uses an account API key in a trusted Node host. Cookie sessions cannot issue SQL credentials. */
export function createRemoteRelationalDatabaseHost(connection: { serverUrl: string; token: string }): RelationalDatabaseHost {
  const url = new URL(connection.serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !connection.token) {
    throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Use a Server HTTP URL and an account API key.");
  }
  const base = connection.serverUrl.replace(/\/+$/, "");
  const request = async <T>(endpoint: string, method: string, body?: unknown, attempt = 0): Promise<T> => {
    try {
      const response = await fetch(`${base}/api/databases/connections${endpoint}`, { method, redirect: "error",
        headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json() as { errCode: number; data?: T & { code?: string }; errMessage?: string };
      if (!response.ok || result.errCode !== 0) {
        const code = result.data?.code;
        // Retry host lock contention before issuing SQL. Business queries are never replayed.
        if (code === "DATABASE_BUSY" && attempt < 8) {
          await delay(Math.min(25 * 2 ** attempt, 500));
          return request(endpoint, method, body, attempt + 1);
        }
        // The server's messages are management diagnostics, not SQL/connection errors.
        if (code?.startsWith("DATABASE_")) throw new DatabaseResourceError(code as DatabaseResourceError["code"], result.errMessage ?? "Database host rejected access.");
        throw new DatabaseResourceError(response.status === 401 || response.status === 403 ? "DATABASE_ACCESS_DENIED" : "DATABASE_UNAVAILABLE", "Database host rejected access. Check the account login.");
      }
      return result.data as T;
    } catch (error) {
      if (error instanceof DatabaseResourceError) throw error;
      throw new DatabaseResourceError("DATABASE_UNAVAILABLE", "Database host is unavailable. Check the Server connection.");
    }
  };
  return {
    open: input => request("", "POST", input),
    async authorize({ credentialId, ...input }) { await request(`/${encodeURIComponent(credentialId)}/authorize`, "POST", input); },
    async release(credentialId) { await request(`/${encodeURIComponent(credentialId)}`, "DELETE"); },
  };
}
