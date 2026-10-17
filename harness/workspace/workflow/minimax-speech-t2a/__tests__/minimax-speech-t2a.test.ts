import { EventEmitter } from "node:events";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runLocalWorkflowWithReport } from "steamharness";
import { decodeHexAudio } from "../lib/audio";
import { synthesizeMinimaxSpeech, type WebSocketLike } from "../lib/minimax-websocket";
import {
  DEFAULT_MINIMAX_T2A_MODEL,
  DEFAULT_MINIMAX_VOICE_ID,
  parseMinimaxSpeechInput,
} from "../lib/validation";
import type { MinimaxSpeechInput } from "../interface";

describe("minimax speech input validation", () => {
  it("parses defaults and trims text", () => {
    const input = parseMinimaxSpeechInput({ text: "  hello  ", dryRun: true });

    expect(input.text).toBe("hello");
    expect(input.errCode).toBe(0);
    expect(input.errMessage).toBe("");
    expect(input.model).toBe(DEFAULT_MINIMAX_T2A_MODEL);
    expect(input.voiceId).toBe(DEFAULT_MINIMAX_VOICE_ID);
    expect(input.format).toBe("mp3");
    expect(input.dryRun).toBe(true);
  });

  it("rejects empty text and invalid numeric ranges", () => {
    expect(() => parseMinimaxSpeechInput({ text: "" })).toThrow(/Text is required/);
    expect(() => parseMinimaxSpeechInput({ text: "ok", speed: 3 })).toThrow(/speed/);
    expect(() => parseMinimaxSpeechInput({ text: "ok", sampleRate: 12345 })).toThrow(/sampleRate/);
  });
});

describe("minimax audio helpers", () => {
  it("decodes hex audio chunks into bytes", () => {
    expect(Array.from(decodeHexAudio(["0001", "ff"]))).toEqual([0, 1, 255]);
  });

  it("rejects invalid hex audio chunks", () => {
    expect(() => decodeHexAudio(["abc"])).toThrow(/invalid hex/);
    expect(() => decodeHexAudio(["zz"])).toThrow(/invalid hex/);
  });
});

describe("minimax dry-run synthesis", () => {
  it("returns a playable wav data URL output item", async () => {
    const report = await runLocalWorkflowWithReport({
      workflowDir: path.resolve(process.cwd(), "workflow/minimax-speech-t2a"),
      workflowName: "minimax-speech-t2a",
      args: [
        "--dry-run",
        "--format",
        "wav",
        "--text",
        "Hello from steamharness.",
      ],
      env: {},
    });

    expect(report.result.ok).toBe(true);
    if (!report.result.ok) return;
    const output = readOutput(report.result.data);
    expect(output.errCode).toBe(0);
    expect(JSON.stringify(report.nodes)).not.toContain("apiKey");
    expect(output.format).toBe("wav");
    expect(output.mimeType).toBe("audio/wav");
    expect(output.audio.src).toMatch(/^data:audio\/wav;base64,/);
    expect(output.items[0]?.contentType).toBe("audio");
    expect(output.items[0]?.content).toMatchObject({
      mimeType: "audio/wav",
      name: "minimax-speech.wav",
      format: "wav",
    });
  });

  it("does not serialize the MiniMax API key into runtime node input", async () => {
    const report = await runLocalWorkflowWithReport({
      workflowDir: path.resolve(process.cwd(), "workflow/minimax-speech-t2a"),
      workflowName: "minimax-speech-t2a",
      args: [
        "--dry-run",
        "--format",
        "wav",
        "--text",
        "Hello from steamharness.",
      ],
      env: { MINIMAX_API_KEY: "test-secret-key" },
    });

    expect(report.result.ok).toBe(true);
    expect(JSON.stringify(report.nodes)).not.toContain("apiKey");
    expect(JSON.stringify(report.nodes)).not.toContain("test-secret-key");
  });
});

describe("minimax websocket client", () => {
  it("runs the task_start, task_continue, task_finish success path", async () => {
    const FakeWebSocket = createFakeWebSocketClass([
      { event: "connected_success", base_resp: { status_code: 0, status_msg: "ok" } },
      { event: "task_started", base_resp: { status_code: 0, status_msg: "ok" } },
      {
        event: "task_continued",
        data: { audio: "0001" },
        is_final: false,
        base_resp: { status_code: 0, status_msg: "ok" },
      },
      {
        event: "task_continued",
        data: { audio: "ff" },
        extra_info: { audio_length: 12 },
        is_final: true,
        base_resp: { status_code: 0, status_msg: "ok" },
      },
      { event: "task_finished", base_resp: { status_code: 0, status_msg: "ok" } },
    ]);

    const result = await synthesizeMinimaxSpeech({
      apiKey: "test-key",
      input: createInput({ dryRun: false }),
      WebSocketImpl: FakeWebSocket,
      timeoutMs: 1000,
    });

    expect(Array.from(result.bytes)).toEqual([0, 1, 255]);
    expect(result.chunkCount).toBe(2);
    expect(result.durationMs).toBe(12);
    expect(FakeWebSocket.instances[0]?.sent.map((item) => JSON.parse(item).event)).toEqual([
      "task_start",
      "task_continue",
      "task_finish",
    ]);
    expect(FakeWebSocket.instances[0]?.headers.Authorization).toBe("Bearer test-key");
  });

  it("turns task_failed into a workflow-visible error", async () => {
    const FakeWebSocket = createFakeWebSocketClass([
      { event: "connected_success", base_resp: { status_code: 0, status_msg: "ok" } },
      { event: "task_failed", base_resp: { status_code: 1001, status_msg: "bad request" } },
    ]);

    await expect(synthesizeMinimaxSpeech({
      apiKey: "test-key",
      input: createInput({ dryRun: false }),
      WebSocketImpl: FakeWebSocket,
      timeoutMs: 1000,
    })).rejects.toThrow(/status=1001/);
  });

  it("rejects non-zero base_resp status codes", async () => {
    const FakeWebSocket = createFakeWebSocketClass([
      { event: "connected_success", base_resp: { status_code: 2, status_msg: "denied" } },
    ]);

    await expect(synthesizeMinimaxSpeech({
      apiKey: "test-key",
      input: createInput({ dryRun: false }),
      WebSocketImpl: FakeWebSocket,
      timeoutMs: 1000,
    })).rejects.toThrow(/status=2/);
  });

  it("turns MiniMax HTTP handshake errors into response errors", async () => {
    const FakeWebSocket = createFakeWebSocketClass([], {
      unexpectedResponse: {
        statusCode: 200,
        statusMessage: "OK",
        body: {
          base_resp: {
            status_code: 2049,
            status_msg: "invalid api key",
          },
        },
      },
    });

    await expect(synthesizeMinimaxSpeech({
      apiKey: "bad-key",
      input: createInput({ dryRun: false }),
      WebSocketImpl: FakeWebSocket,
      timeoutMs: 1000,
    })).rejects.toThrow(/status=2049 message=invalid api key/);
  });

  it("supports abort and timeout", async () => {
    const AbortWebSocket = createFakeWebSocketClass([], { autoMessages: false });
    const controller = new AbortController();
    const aborted = synthesizeMinimaxSpeech({
      apiKey: "test-key",
      input: createInput({ dryRun: false }),
      WebSocketImpl: AbortWebSocket,
      signal: controller.signal,
      timeoutMs: 1000,
    });
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/);

    const TimeoutWebSocket = createFakeWebSocketClass([], { autoMessages: false });
    await expect(synthesizeMinimaxSpeech({
      apiKey: "test-key",
      input: createInput({ dryRun: false }),
      WebSocketImpl: TimeoutWebSocket,
      timeoutMs: 5,
    })).rejects.toThrow(/timed out/);
  });
});

function createInput(overrides: Partial<MinimaxSpeechInput> = {}): MinimaxSpeechInput {
  return {
    errCode: 0,
    errMessage: "",
    text: "Hello from steamharness.",
    model: DEFAULT_MINIMAX_T2A_MODEL,
    voiceId: DEFAULT_MINIMAX_VOICE_ID,
    format: "mp3",
    sampleRate: 32000,
    bitrate: 128000,
    channel: 1,
    speed: 1,
    vol: 1,
    pitch: 0,
    dryRun: true,
    timeoutMs: 120000,
    ...overrides,
  };
}

function createFakeWebSocketClass(
  messages: unknown[],
  options: {
    autoMessages?: boolean;
    unexpectedResponse?: {
      statusCode: number;
      statusMessage: string;
      body: unknown;
    };
  } = {},
) {
  class FakeWebSocket extends EventEmitter implements WebSocketLike {
    static instances: FakeWebSocket[] = [];

    readonly headers: Record<string, string>;
    readonly sent: string[] = [];
    closed = false;

    constructor(_url: string, init?: { headers?: Record<string, string> }) {
      super();
      this.headers = init?.headers ?? {};
      FakeWebSocket.instances.push(this);
      if (options.unexpectedResponse !== undefined) {
        setTimeout(() => {
          const response = Readable.from([JSON.stringify(options.unexpectedResponse?.body)]) as Readable & {
            statusCode?: number;
            statusMessage?: string;
          };
          response.statusCode = options.unexpectedResponse?.statusCode;
          response.statusMessage = options.unexpectedResponse?.statusMessage;
          this.emit("unexpected-response", {}, response);
        }, 1);
        return;
      }
      if (options.autoMessages !== false) {
        for (const [index, message] of messages.entries()) {
          setTimeout(() => this.emit("message", JSON.stringify(message)), index + 1);
        }
      }
    }

    send(data: string, callback?: (error?: Error) => void): void {
      this.sent.push(data);
      callback?.();
    }

    close(): void {
      this.closed = true;
    }
  }

  return FakeWebSocket;
}

function readOutput(value: unknown): Record<string, unknown> & {
  audio: { src: string };
  items: Array<{ contentType?: string; content?: unknown }>;
} {
  expect(typeof value).toBe("object");
  expect(value).not.toBe(null);
  const outer = value as { output?: unknown };
  expect(typeof outer.output).toBe("object");
  expect(outer.output).not.toBe(null);
  return outer.output as Record<string, unknown> & {
    audio: { src: string };
    items: Array<{ contentType?: string; content?: unknown }>;
  };
}
