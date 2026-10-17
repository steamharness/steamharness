import { tool, type FunctionTool } from "@openai/agents";
import { z } from "zod";
import type { AgentToolCallSummary } from "./interface";

const TEST_TOOL_TIMEOUT_MS = 5_000;
const TEST_TOOL_MAX_BODY_CHARS = 2_000;

const testToolParameters = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST"]).optional(),
  headers: z.record(z.string().min(1).max(80), z.string().max(500)).optional(),
  body: z.string().max(TEST_TOOL_MAX_BODY_CHARS).optional(),
});

export type TestToolInput = z.infer<typeof testToolParameters>;

export interface TestToolResult {
  ok: boolean;
  url: string;
  method: "GET" | "POST";
  status: number;
  statusText: string;
  contentType: string;
  bodyPreview: string;
  bodyLength: number;
}

export interface CreateTestToolOptions {
  signal?: AbortSignal;
  toolEvents: AgentToolCallSummary[];
}

export function createTestTool<Context = unknown>(
  options: CreateTestToolOptions,
): FunctionTool<Context, typeof testToolParameters, TestToolResult> {
  return tool<typeof testToolParameters, Context, TestToolResult>({
    name: "test_tool",
    description: [
      "Send a small HTTP GET or POST request for workflow connectivity tests.",
      "Return status, content type, and a short response body preview.",
    ].join(" "),
    parameters: testToolParameters,
    timeoutMs: TEST_TOOL_TIMEOUT_MS,
    timeoutBehavior: "error_as_result",
    async execute(args) {
      try {
        const result = await runTestToolRequest(args, { signal: options.signal });
        options.toolEvents.push({
          name: "test_tool",
          status: result.ok ? "completed" : "failed",
        });
        return result;
      } catch (error) {
        options.toolEvents.push({ name: "test_tool", status: "failed" });
        throw error;
      }
    },
  });
}

export async function runTestToolRequest(
  input: TestToolInput,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<TestToolResult> {
  const url = parseHttpUrl(input.url);
  const method = input.method ?? "GET";
  if (method === "GET" && input.body !== undefined) {
    throw new Error("test_tool GET requests cannot include a body.");
  }

  const { signal, cleanup } = createTimeoutSignal(options.signal, TEST_TOOL_TIMEOUT_MS);
  try {
    const headers = normalizeRequestHeaders(input.headers, method, input.body);
    const response = await (options.fetchImpl ?? fetch)(url, {
      method,
      headers,
      body: method === "POST" ? input.body ?? "" : undefined,
      signal,
    });
    const body = await response.text();

    return {
      ok: response.ok,
      url: response.url,
      method,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? "",
      bodyPreview: truncateText(body, TEST_TOOL_MAX_BODY_CHARS),
      bodyLength: body.length,
    };
  } finally {
    cleanup();
  }
}

function parseHttpUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("test_tool only supports http and https URLs.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("test_tool URLs must not include credentials.");
  }
  return url.toString();
}

function normalizeRequestHeaders(
  headers: Record<string, string> | undefined,
  method: "GET" | "POST",
  body: string | undefined,
): Record<string, string> | undefined {
  const normalized = { ...(headers ?? {}) };
  if (
    method === "POST"
    && body !== undefined
    && !Object.keys(normalized).some((key) => key.toLowerCase() === "content-type")
  ) {
    normalized["content-type"] = "text/plain; charset=utf-8";
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (parent?.aborted) {
    abort();
  } else {
    parent?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[response truncated]`;
}
