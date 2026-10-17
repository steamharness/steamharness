/**
 * MiniMax M3 video understanding client.
 *
 * Mirrors the validated Python reference client so the workflow can upload a
 * Bilibili video to MiniMax and ask M3 to describe it.
 * The two endpoints are:
 *
 *   POST {baseUrl}/files/upload   multipart/form-data, purpose=video_understanding
 *                                 → { file: { file_id } }
 *   POST {baseUrl}/chat/completions  JSON, model=MiniMax-M3, stream=true
 *                                 → SSE chunks of `choices[0].delta.content`
 *
 *  the API key is the same one MiniMax uses for chat, TTS, and voice
 * clone; missing-key failures throw so the workflow can surface them in the
 * knowledge document error path.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseSseStream, type SseEvent } from "./sse";
import { buildMultipartBody } from "./multipart";

export const DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";

export interface MinimaxClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Max retry attempts for transient network failures. */
  maxRetries?: number;
  /** Initial backoff in ms; doubles on every retry. */
  retryBackoffMs?: number;
  /** Per-request timeout in ms; defaults to 5 minutes for large video uploads. */
  requestTimeoutMs?: number;
}

export interface MinimaxUploadResult {
  fileId: string;
  raw: unknown;
}

export interface MinimaxUnderstandRequest {
  videoUrl: string;
  question?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** When true, also yield the raw SSE chunks. */
  includeRawChunks?: boolean;
  /** Callback for each decoded content delta. */
  onContent?: (delta: string) => void;
}

export interface MinimaxUnderstandResult {
  transcript: string;
  chunks: number;
  model: string;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BACKOFF_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — large video uploads
const DEFAULT_MODEL = "MiniMax-M3";
const DEFAULT_MAX_TOKENS = 524288;
const DEFAULT_QUESTION = "请详细描述这个视频里发生了什么";

export class MinimaxClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;

  constructor(options: MinimaxClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new Error("MinimaxClient requires a non-empty apiKey.");
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_MINIMAX_BASE_URL).replace(/\/+$/, "");
    // Wrap the user-provided (or global) fetch with a per-request timeout so
    // a stale socket cannot hang the upload indefinitely. Retries will open
    // fresh sockets, which is the workaround for UND_ERR_SOCKET when an
    // intermediate network device silently resets the connection during
    // a large multi-MB upload.
    this.fetchImpl = createResilientFetch(
      options.fetchImpl ?? resolveDefaultFetch(),
      { timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
    );
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  async uploadFile(localPath: string, options: { purpose?: string; signal?: AbortSignal } = {}): Promise<MinimaxUploadResult> {
    const purpose = options.purpose ?? "video_understanding";
    const buffer = await readFile(localPath);
    const filename = basename(localPath);
    const multipart = buildMultipartBody(
      [{ name: "purpose", value: purpose }],
      [{ name: "file", filename, contentType: "application/octet-stream", buffer }],
    );

    const response = await this.fetchWithRetry(`${this.baseUrl}/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": multipart.contentType,
        // MiniMax receives the complete multipart payload, not just
        // the raw video bytes; an undersized Content-Length can make the server
        // close the socket during upload and surface as UND_ERR_SOCKET in Node.
        "Content-Length": String(multipart.body.byteLength),
      },
      body: multipart.body,
      signal: options.signal,
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new Error(`Minimax upload failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const payload = await response.json() as unknown;
    const fileId = readFileId(payload);
    if (fileId === undefined) {
      throw new Error(`Minimax upload response missing file_id: ${JSON.stringify(payload).slice(0, 500)}`);
    }
    return { fileId, raw: payload };
  }

  async understandVideo(input: MinimaxUnderstandRequest): Promise<MinimaxUnderstandResult> {
    const model = input.model ?? DEFAULT_MODEL;
    const question = input.question ?? DEFAULT_QUESTION;
    const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
    const videoUrl = input.videoUrl;

    const payload = {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "video_url", video_url: { url: videoUrl } },
          ],
        },
      ],
      thinking: { type: "adaptive" },
      max_completion_tokens: maxTokens,
      stream: true,
    };

    const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: input.signal,
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new Error(`Minimax understand failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const buffer: string[] = [];
    let chunks = 0;
    for await (const event of parseSseStream(response.body, input.signal)) {
      const delta = extractContentDelta(event);
      if (delta === undefined) {
        continue;
      }
      chunks += 1;
      buffer.push(delta);
      input.onContent?.(delta);
    }

    return { transcript: buffer.join(""), chunks, model };
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, init);
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Minimax HTTP ${response.status}`);
          if (attempt < this.maxRetries - 1) {
            await delay(this.retryBackoffMs * Math.pow(2, attempt), init.signal);
            continue;
          }
          return response;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries - 1) {
          await delay(this.retryBackoffMs * Math.pow(2, attempt), init.signal);
          continue;
        }
        throw this.describeFetchError(url, attempt + 1, error);
      }
    }
    throw this.describeFetchError(url, this.maxRetries, lastError);
  }

  private describeFetchError(url: string, attempts: number, error: unknown): Error {
    const causeMessage = error instanceof Error ? error.message : String(error);
    const rootCause = unwrapError(error);
    const sysCode = readNodeSystemCode(rootCause);
    const sysLabel = sysCode !== undefined ? ` (${sysCode})` : "";
    const attemptLabel = attempts > 1 ? ` after ${attempts} attempts` : "";
    return new Error(
      `Minimax request to ${url} failed${attemptLabel}: ${causeMessage}${sysLabel}. ` +
        `Check MINIMAX_API_KEY, MINIMAX_BASE_URL, and outbound network.`,
    );
  }
}

export function readMinimaxApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidate = env.MINIMAX_API_KEY ?? env.MINIMAX_VIDEO_API_KEY;
  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function readMinimaxApiKeyFromMetadata(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const candidate = (metadata as { minimaxApiKey?: unknown }).minimaxApiKey;
  return typeof candidate === "string" && candidate.trim() !== ""
    ? candidate.trim()
    : undefined;
}

export function readMinimaxBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.MINIMAX_BASE_URL;
  if (typeof candidate !== "string") {
    return DEFAULT_MINIMAX_BASE_URL;
  }
  const trimmed = candidate.trim();
  return trimmed === "" ? DEFAULT_MINIMAX_BASE_URL : trimmed;
}

export function mmFileReference(fileId: string): string {
  return `mm_file://${fileId}`;
}

function extractContentDelta(event: SseEvent): string | undefined {
  if (!isObject(event.data)) {
    return undefined;
  }
  const choices = (event.data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const first = choices[0];
  if (!isObject(first)) {
    return undefined;
  }
  const delta = (first as { delta?: unknown }).delta;
  if (!isObject(delta)) {
    return undefined;
  }
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function readFileId(payload: unknown): string | undefined {
  if (!isObject(payload)) {
    return undefined;
  }
  const file = (payload as { file?: unknown }).file;
  if (!isObject(file)) {
    return undefined;
  }
  const id = (file as { file_id?: unknown }).file_id;
  if (typeof id === "string" && id !== "") {
    return id;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDefaultFetch(): typeof fetch {
  const candidate = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof candidate === "function") {
    return candidate.bind(globalThis);
  }
  throw new Error("Minimax client requires a fetch implementation; provide fetchImpl or run on Node 18+.");
}

/**
 * Wrap an existing fetch implementation with a per-request abort timeout
 * so a long upload cannot hang on a stale socket indefinitely. Node 18+
 * `AbortSignal.timeout` cancels the underlying undici fetch cleanly,
 * letting the retry loop open a fresh connection.
 *
 * Returns a fetch with the same signature; the wrapped implementation
 * also composes the user-supplied `signal` so callers can still cancel
 * manually (e.g. on workflow abort).
 */
export function createResilientFetch(
  baseImpl: typeof fetch,
  options: { timeoutMs?: number } = {},
): typeof fetch {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return function resilientFetch(input, init) {
    const userSignal = (init as RequestInit | undefined)?.signal ?? undefined;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = userSignal
      ? composeAbortSignals(userSignal, timeoutSignal)
      : timeoutSignal;
    return baseImpl(input as RequestInfo, { ...(init as RequestInit), signal } as RequestInit);
  } as unknown as typeof fetch;
}

function composeAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function unwrapError(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      current !== null &&
      typeof current === "object" &&
      "cause" in current &&
      (current as { cause: unknown }).cause !== undefined &&
      (current as { cause: unknown }).cause !== current
    ) {
      current = (current as { cause: unknown }).cause;
    } else {
      break;
    }
  }
  return current;
}

function readNodeSystemCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Minimax request was aborted."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Minimax request was aborted."));
    }, { once: true });
  });
}
