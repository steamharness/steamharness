import { decodeHexAudio } from "./audio";
import type { MinimaxSpeechInput } from "../interface";

export const MINIMAX_T2A_WEBSOCKET_URL = "wss://api.minimaxi.com/ws/v1/t2a_v2";

export interface MinimaxWebSocketSpeechOptions {
  apiKey: string;
  input: MinimaxSpeechInput;
  signal?: AbortSignal;
  timeoutMs?: number;
  WebSocketImpl?: WebSocketConstructor;
}

export interface MinimaxWebSocketSpeechResult {
  bytes: Uint8Array;
  chunkCount: number;
  durationMs?: number;
}

export interface WebSocketLike {
  on(event: "open" | "message" | "error" | "close", listener: (...args: unknown[]) => void): this;
  on(event: "unexpected-response", listener: (request: unknown, response: WebSocketUnexpectedResponse) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(): void;
}

export interface WebSocketUnexpectedResponse {
  statusCode?: number;
  statusMessage?: string;
  on(event: "data", listener: (chunk: unknown) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
}

export type WebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

interface MinimaxResponse {
  event?: string;
  is_final?: boolean;
  data?: {
    audio?: unknown;
    status?: unknown;
  };
  extra_info?: {
    audio_length?: unknown;
  };
  base_resp?: {
    status_code?: unknown;
    status_msg?: unknown;
  };
}

interface MessageWaiter {
  resolve: (value: MinimaxResponse) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
}

export async function synthesizeMinimaxSpeech(
  options: MinimaxWebSocketSpeechOptions,
): Promise<MinimaxWebSocketSpeechResult> {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") {
    throw new Error("MiniMax speech synthesis requires MINIMAX_API_KEY.");
  }

  const WebSocketImpl = options.WebSocketImpl ?? await loadWsConstructor();
  const timeoutMs = options.timeoutMs ?? options.input.timeoutMs;
  const ws = new WebSocketImpl(MINIMAX_T2A_WEBSOCKET_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const session = createWebSocketSession(ws, options.signal);

  try {
    await expectEvent(session, "connected_success", timeoutMs);
    await sendJson(ws, createTaskStartMessage(options.input));
    await expectEvent(session, "task_started", timeoutMs);
    await sendJson(ws, { event: "task_continue", text: options.input.text });

    const hexChunks: string[] = [];
    let durationMs: number | undefined;
    while (true) {
      const event = await session.next(timeoutMs);
      assertMiniMaxSuccess(event);
      if (event.event === "task_failed") {
        throw createMiniMaxResponseError("MiniMax T2A task failed.", event);
      }
      if (event.event !== "task_continued") {
        continue;
      }

      const audio = event.data?.audio;
      if (typeof audio === "string" && audio.trim() !== "") {
        hexChunks.push(audio);
      }
      const audioLength = readNumber(event.extra_info?.audio_length);
      if (audioLength !== undefined) {
        durationMs = audioLength;
      }
      if (event.is_final === true) {
        break;
      }
    }

    await sendJson(ws, { event: "task_finish" });
    await expectEvent(session, "task_finished", timeoutMs);
    if (hexChunks.length === 0) {
      throw new Error("MiniMax T2A returned no audio chunks.");
    }

    return {
      bytes: decodeHexAudio(hexChunks),
      chunkCount: hexChunks.length,
      durationMs,
    };
  } finally {
    session.dispose();
    ws.close();
  }
}

function createTaskStartMessage(input: MinimaxSpeechInput): Record<string, unknown> {
  const voiceSetting: Record<string, unknown> = {
    voice_id: input.voiceId,
    speed: input.speed,
    vol: input.vol,
    pitch: input.pitch,
  };
  if (input.emotion !== undefined) {
    voiceSetting.emotion = input.emotion;
  }

  return {
    event: "task_start",
    model: input.model,
    ...(input.languageBoost === undefined ? {} : { language_boost: input.languageBoost }),
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: input.sampleRate,
      bitrate: input.bitrate,
      format: input.format,
      channel: input.channel,
    },
  };
}

function createWebSocketSession(ws: WebSocketLike, signal: AbortSignal | undefined) {
  const queue: MinimaxResponse[] = [];
  const waiters: MessageWaiter[] = [];
  let closed = false;
  let terminalError: unknown;

  const rejectAll = (reason: unknown) => {
    terminalError = reason;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter === undefined) continue;
      clearTimeout(waiter.timeout);
      waiter.reject(reason);
    }
  };

  const pushMessage = (message: MinimaxResponse) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  };

  ws.on("message", (data) => {
    try {
      const message = parseWebSocketMessage(data);
      assertMiniMaxSuccess(message);
      if (message.event === "task_failed") {
        rejectAll(createMiniMaxResponseError("MiniMax T2A task failed.", message));
        return;
      }
      pushMessage(message);
    } catch (error) {
      rejectAll(error);
    }
  });
  ws.on("error", (error) => rejectAll(error instanceof Error ? error : new Error(String(error))));
  ws.on("close", () => {
    closed = true;
    if (terminalError === undefined) {
      rejectAll(new Error("MiniMax T2A WebSocket closed before the task completed."));
    }
  });
  ws.on("unexpected-response", (_request, response) => {
    void readUnexpectedResponseError(response)
      .then(rejectAll, rejectAll);
  });

  const abort = () => {
    rejectAll(new Error("MiniMax T2A WebSocket synthesis was aborted."));
    ws.close();
  };
  signal?.addEventListener("abort", abort, { once: true });

  return {
    next(timeoutMs: number): Promise<MinimaxResponse> {
      const queued = queue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      if (terminalError !== undefined) {
        return Promise.reject(terminalError);
      }
      if (closed) {
        return Promise.reject(new Error("MiniMax T2A WebSocket is closed."));
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.reject === reject);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`MiniMax T2A WebSocket timed out after ${timeoutMs}ms.`));
          ws.close();
        }, timeoutMs);
        waiters.push({ resolve, reject, timeout });
      });
    },
    dispose() {
      signal?.removeEventListener("abort", abort);
      rejectAll(new Error("MiniMax T2A WebSocket session disposed."));
    },
  };
}

async function expectEvent(
  session: { next(timeoutMs: number): Promise<MinimaxResponse> },
  expected: string,
  timeoutMs: number,
): Promise<MinimaxResponse> {
  while (true) {
    const event = await session.next(timeoutMs);
    assertMiniMaxSuccess(event);
    if (event.event === expected) {
      return event;
    }
    if (event.event === "task_failed") {
      throw createMiniMaxResponseError("MiniMax T2A task failed.", event);
    }
  }
}

function parseWebSocketMessage(data: unknown): MinimaxResponse {
  const text = typeof data === "string"
    ? data
    : data instanceof Buffer
      ? data.toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data as Buffer[]).toString("utf8")
        : String(data);
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("MiniMax T2A WebSocket returned a non-object message.");
  }
  return parsed as MinimaxResponse;
}

async function readUnexpectedResponseError(response: WebSocketUnexpectedResponse): Promise<Error> {
  const body = await readResponseBody(response);
  if (body.trim() !== "") {
    try {
      const message = parseWebSocketMessage(body);
      return createMiniMaxResponseError("MiniMax T2A WebSocket handshake failed.", message);
    } catch {
      return new Error(
        `MiniMax T2A WebSocket handshake failed with HTTP ${response.statusCode ?? "unknown"} ${response.statusMessage ?? ""}: ${body.trim()}`,
      );
    }
  }
  return new Error(`MiniMax T2A WebSocket handshake failed with HTTP ${response.statusCode ?? "unknown"} ${response.statusMessage ?? ""}.`);
}

function readResponseBody(response: WebSocketUnexpectedResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => {
      if (chunk instanceof Buffer) {
        chunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else {
        chunks.push(Buffer.from(String(chunk)));
      }
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}

function assertMiniMaxSuccess(message: MinimaxResponse): void {
  const statusCode = readNumber(message.base_resp?.status_code);
  if (statusCode !== undefined && statusCode !== 0) {
    throw createMiniMaxResponseError("MiniMax T2A returned an error response.", message);
  }
}

function createMiniMaxResponseError(prefix: string, message: MinimaxResponse): Error {
  const statusCode = readNumber(message.base_resp?.status_code);
  const statusMsg = typeof message.base_resp?.status_msg === "string" ? message.base_resp.status_msg : "unknown";
  const event = message.event ?? "unknown";
  return new Error(`${prefix} event=${event} status=${statusCode ?? "unknown"} message=${statusMsg}`);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sendJson(ws: WebSocketLike, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(value), (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function loadWsConstructor(): Promise<WebSocketConstructor> {
  const module = await import("ws");
  const candidate = module.default ?? module.WebSocket;
  return candidate as unknown as WebSocketConstructor;
}
