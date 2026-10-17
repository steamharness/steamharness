import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
const PLACEHOLDER_API_KEY = "workflow-loopback-proxy";
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface WorkflowServerOpenAIProxyBridge {
  readonly baseUrl: string;
  readonly apiKey: string;
  close(): Promise<void>;
}

export type WorkflowServerLLMProxyProtocol = "openai-responses" | "anthropic";
export type WorkflowServerLLMProxyBridge = WorkflowServerOpenAIProxyBridge;

interface StartOpenAIProxyBridgeOptions {
  targetUrl: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}

interface StartLLMProxyBridgeOptions extends StartOpenAIProxyBridgeOptions {
  protocol: WorkflowServerLLMProxyProtocol;
}

export async function startOpenAIProxyBridge(
  options: StartOpenAIProxyBridgeOptions,
): Promise<WorkflowServerOpenAIProxyBridge> {
  return startLLMProxyBridge({ ...options, protocol: "openai-responses" });
}

export async function startLLMProxyBridge(
  options: StartLLMProxyBridgeOptions,
): Promise<WorkflowServerLLMProxyBridge> {
  options.signal?.throwIfAborted();
  const endpoint = options.protocol === "anthropic" ? "messages" : "responses";
  const endpointPath = `/${randomBytes(24).toString("hex")}/v1/${endpoint}`;
  const activeRequests = new Set<AbortController>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      endpointPath,
      activeRequests,
    }).catch((error) => {
      if (response.headersSent || response.destroyed) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      sendJson(response, 502, "Workflow Server AI 代理请求失败。");
    });
  });

  await listenOnLoopback(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("无法创建本地 AI 代理桥。");
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      options.signal?.removeEventListener("abort", closeOnAbort);
      activeRequests.forEach((controller) => controller.abort());
      server.closeAllConnections?.();
      await closeServer(server);
    })();
    return closePromise;
  };
  const closeOnAbort = () => {
    void close();
  };
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });
  if (options.signal?.aborted) {
    await close();
    options.signal.throwIfAborted();
  }

  return Object.freeze({
    baseUrl: `http://${LOOPBACK_HOST}:${address.port}${endpointPath.slice(0, -(endpoint.length + 1))}`,
    apiKey: PLACEHOLDER_API_KEY,
    close,
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartOpenAIProxyBridgeOptions & {
    endpointPath: string;
    activeRequests: Set<AbortController>;
  },
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
  if (request.method !== "POST" || requestUrl.pathname !== options.endpointPath) {
    request.resume();
    sendJson(response, 404, "Not found.");
    return;
  }

  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    request.resume();
    sendJson(response, 413, "Request body exceeds the 50 MiB limit.");
    return;
  }

  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  const abortOnResponseClose = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abortUpstream);
  response.once("close", abortOnResponseClose);
  options.activeRequests.add(controller);

  try {
    const body = await readRequestBody(request, MAX_REQUEST_BODY_BYTES);
    const headers = copyHeaders(request.headers, STRIPPED_REQUEST_HEADERS);
    const upstream = await options.fetchImpl(options.targetUrl, {
      method: "POST",
      headers,
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      signal: controller.signal,
    });

    response.statusCode = upstream.status;
    response.statusMessage = upstream.statusText;
    upstream.headers.forEach((value, name) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
    });
    if (!upstream.body) {
      response.end();
      return;
    }
    await pipeResponseBody(upstream.body, response);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError && !response.headersSent) {
      sendJson(response, 413, "Request body exceeds the 50 MiB limit.");
      return;
    }
    if (controller.signal.aborted || response.destroyed) return;
    throw error;
  } finally {
    options.activeRequests.delete(controller);
    request.removeListener("aborted", abortUpstream);
    response.removeListener("close", abortOnResponseClose);
  }
}

async function pipeResponseBody(body: ReadableStream<Uint8Array>, response: ServerResponse): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!response.write(Buffer.from(chunk.value))) await waitForDrain(response);
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      response.removeListener("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Local AI proxy client disconnected."));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

async function readRequestBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function copyHeaders(
  source: IncomingMessage["headers"],
  stripped: ReadonlySet<string>,
): Headers {
  const headers = new Headers();
  Object.entries(source).forEach(([name, value]) => {
    if (stripped.has(name.toLowerCase()) || value === undefined) return;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  });
  return headers;
}

function sendJson(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: { message } }));
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

class RequestBodyTooLargeError extends Error {}
