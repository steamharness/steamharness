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

/** Authenticated structured transport for native preview hosts; no SQL credentials enter the page. */
export function createRemoteDatabaseQueryHost(connection: { serverUrl: string; token: string }, consumer: { projectId: string; entryId: string }): import('./browser-runtime').DatabaseQueryHost {
  const request = async (endpoint: string, body: unknown) => {
    let response: Response;
    try { response = await fetch(`${connection.serverUrl.replace(/\/+$/, '')}/api/databases${endpoint}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000), headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { throw new DatabaseResourceError('DATABASE_UNAVAILABLE', 'Database host is unavailable.'); }
    const result = await response.json() as { errCode: number; data: any; errMessage?: string };
    if (!response.ok || result.errCode !== 0) throw new DatabaseResourceError(result.data?.code ?? 'DATABASE_UNAVAILABLE', result.errMessage ?? 'Database query failed.');
    return result.data;
  };
  return {
    resolve: input => request('/bindings/resolve', { ...consumer, ...input }),
    query: (binding, schemaHash, query) => request(`/${encodeURIComponent(binding.databaseId)}/query`, {
      consumer: { ...consumer, alias: binding.alias, schemaHash, binding: { id: binding.id, revision: binding.revision }, accessRevision: binding.accessRevision }, request: query,
    }),
  };
}

export async function executeDatabaseQueryBridge(host: import('./browser-runtime').DatabaseQueryHost, operation: string, input: Record<string, unknown>): Promise<unknown> {
  if (operation === 'database.resolve') return host.resolve({ alias: String(input.database), schemaHash: String(input.schemaHash) });
  if (operation !== 'database.query' || !input.binding || typeof input.binding !== 'object' || (input.binding as { alias?: string }).alias !== input.database) throw new DatabaseResourceError('DATABASE_INVALID_REQUEST', 'Invalid database query.');
  return host.query(input.binding as import('./browser-runtime').DatabaseQueryBinding, String(input.schemaHash), input.request as import('./browser-runtime').DatabaseTableRequest);
}
