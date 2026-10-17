import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';

export interface StudioControlBridge {
  url: string;
  token: string;
  close(): Promise<void>;
}

export type StudioControlPermissionPolicy = 'read-only' | 'workspace' | 'auto';

export async function startStudioControlBridge(
  execute: (operation: string, input: Record<string, unknown>, permissionPolicy: StudioControlPermissionPolicy) => Promise<unknown>,
  signal: AbortSignal,
): Promise<StudioControlBridge> {
  signal.throwIfAborted();
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const reply = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (request.method !== 'POST' || request.url !== '/studio-control' || request.headers.origin !== undefined
      || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      reply(response, 403, { ok: false, error: { code: 'STUDIO_CONTROL_UNAUTHORIZED', message: 'Invalid Studio Control capability.' } });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024) { throw new Error('Studio Control request is too large.'); }
        chunks.push(chunk);
      }
      const call: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!isRecord(call) || typeof call.operation !== 'string' || !isRecord(call.input)
        || Object.keys(call).some(key => !['operation', 'input', 'permissionPolicy'].includes(key))
        || (call.permissionPolicy !== undefined && !['read-only', 'workspace', 'auto'].includes(call.permissionPolicy as string))) {
        throw new Error('Invalid Studio Control request.');
      }
      signal.throwIfAborted();
      const value = await execute(call.operation, call.input, (call.permissionPolicy ?? 'workspace') as StudioControlPermissionPolicy);
      reply(response, 200, { ok: true, value });
    } catch (error) {
      reply(response, 400, { ok: false, error: { code: 'STUDIO_CONTROL_INVALID_REQUEST', message: error instanceof Error ? error.message : String(error) } });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= new Promise<void>((resolve, reject) => {
    signal.removeEventListener('abort', aborted);
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  });
  const aborted = (): void => { void close(); };
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) { await close(); signal.throwIfAborted(); }
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('Studio Control failed to bind its loopback address.'); }
  return { url: `http://127.0.0.1:${address.port}/studio-control`, token, close };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
