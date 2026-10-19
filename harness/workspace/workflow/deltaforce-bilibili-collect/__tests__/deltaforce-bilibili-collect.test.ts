/**
 * Tests for the M3-driven deltaforce-bilibili-collect workflow.
 *
 *  every test below stays offline; env-gated mocks
 * (`DELTAFORCE_BILIBILI_DOWNLOAD_MOCK`, `MINIMAX_DRY_RUN`) plus a stubbed
 * global `fetch` let us exercise the full pipeline without touching real
 * B 站 or MiniMax.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalWorkflowWithReport, type KVStore, type RuntimeEvent } from "steamharness";
import {
  createBilibiliPlayUrl,
  fetchBilibiliDownloadUrl,
  normalizeVideoInfo,
  parseVideoCodecPreference,
  pickBestVideoStream,
} from "../lib/bilibili";
import { parseBilibiliVideoLink } from "../lib/link";
import { buildMultipartBody } from "../lib/multipart";
import { MinimaxClient } from "../lib/minimax";
import { parseSseStream } from "../lib/sse";
import { splitTranscriptByThinking, transcriptToMarkdown } from "../lib/transcript";
import type { DeltaforceBilibiliCollectOutputPayload } from "../interface";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("deltaforce-bilibili-collect helpers", () => {
  it("parses BV ids and bilibili video URLs", () => {
    expect(parseBilibiliVideoLink("BV1uv411q7Mv")).toEqual({
      bvid: "BV1uv411q7Mv",
      normalizedUrl: "https://www.bilibili.com/video/BV1uv411q7Mv",
    });
    expect(parseBilibiliVideoLink("https://www.bilibili.com/video/BV1uv411q7Mv/?spm_id_from=333#reply")).toEqual({
      bvid: "BV1uv411q7Mv",
      normalizedUrl: "https://www.bilibili.com/video/BV1uv411q7Mv",
    });
    expect(() => parseBilibiliVideoLink("https://example.com/nope")).toThrow(/BV id/);
  });

  it("builds multipart bodies with a valid boundary and content type", () => {
    const multipart = buildMultipartBody(
      [{ name: "purpose", value: "video_understanding" }],
      [{
        name: "file",
        filename: "video.mp4",
        contentType: "application/octet-stream",
        buffer: Buffer.from("hello"),
      }],
    );
    const header = multipart.body.toString("utf8").split("\r\n").slice(0, 8).join("\r\n");
    expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=----steamharness-/);
    expect(header).toContain("Content-Disposition: form-data; name=\"purpose\"");
    expect(header).toContain("Content-Disposition: form-data; name=\"file\"; filename=\"video.mp4\"");
    expect(header).toContain("Content-Type: application/octet-stream");
    expect(multipart.body.toString("utf8")).toContain("video_understanding");
  });

  it("escapes non-ASCII filenames inside multipart headers", () => {
    const multipart = buildMultipartBody(
      [],
      [{
        name: "file",
        filename: "中文 \n文件名.mp4",
        contentType: "application/octet-stream",
        buffer: Buffer.from("x"),
      }],
    );
    const text = multipart.body.toString("utf8");
    expect(text).toContain("filename=\"中文  文件名.mp4\"");
    expect(text).not.toContain("\n中文");
  });

  it("sets MiniMax upload Content-Length to the full multipart body size", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-minimax-upload-"));
    const filePath = path.join(tempDir, "video.mp4");
    const rawVideo = Buffer.from("video-bytes");
    await writeFile(filePath, rawVideo);
    try {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = readHeaders(init?.headers);
        const body = init?.body;
        expect(Buffer.isBuffer(body)).toBe(true);
        const bodyLength = Buffer.isBuffer(body) ? body.byteLength : 0;
        expect(headers["content-length"]).toBe(String(bodyLength));
        expect(bodyLength).toBeGreaterThan(rawVideo.byteLength);
        return new Response(JSON.stringify({ file: { file_id: "file-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const client = new MinimaxClient({
        apiKey: "test-key",
        fetchImpl: fetchMock as unknown as typeof fetch,
      });
      await expect(client.uploadFile(filePath)).resolves.toMatchObject({ fileId: "file-1" });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses SSE streams that arrive in arbitrary chunk boundaries", async () => {
    const events = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n",
      "\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n",
      "\n",
      "data: [DONE]\n",
      "\n",
    ].join("");
    const halves = splitInHalf(events);
    const stream = makeStream([halves.first, halves.second]);
    const decoded: unknown[] = [];
    for await (const event of parseSseStream(stream)) {
      decoded.push(event.data);
    }
    expect(decoded).toEqual([
      { choices: [{ delta: { content: "hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
    ]);
  });

  it("stops parsing at data: [DONE] even if more bytes follow", async () => {
    const stream = makeStream([
      "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\ndata: [DONE]\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n",
    ]);
    const decoded: unknown[] = [];
    for await (const event of parseSseStream(stream)) {
      decoded.push(event.data);
    }
    expect(decoded).toEqual([{ choices: [{ delta: { content: "a" } }] }]);
  });

  it("ignores comment lines and tolerates CRLF line endings", async () => {
    const stream = makeStream([
      ": keep-alive\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\r\n\r\n",
    ]);
    const decoded: unknown[] = [];
    for await (const event of parseSseStream(stream)) {
      decoded.push(event.data);
    }
    expect(decoded).toEqual([{ choices: [{ delta: { content: "hi" } }] }]);
  });

  it("returns no events for an empty body", async () => {
    const decoded: unknown[] = [];
    for await (const event of parseSseStream(makeStream([""]))) {
      decoded.push(event.data);
    }
    expect(decoded).toEqual([]);
  });

  it("splits transcripts into thinking + content sections", () => {
    const sections = splitTranscriptByThinking("hello<think>plan</think>world");
    expect(sections).toEqual([
      { kind: "content", text: "hello" },
      { kind: "thinking", text: "plan" },
      { kind: "content", text: "world" },
    ]);
  });

  it("renders transcript markdown with thinking and content sections", () => {
    const markdown = transcriptToMarkdown({
      title: "视频标题",
      video: {
        bvid: "BV1uv411q7Mv",
        aid: 1,
        cid: 2,
        pageIndex: 0,
        link: "https://www.bilibili.com/video/BV1uv411q7Mv",
        duration: 120,
      },
      model: "MiniMax-M3",
      question: "讲了什么",
      promptSeconds: 150,
      transcript: "<think>M3 reasoning</think>M3 描述。",
      fileId: "file-1",
      knowledgeWritten: true,
      dryRun: false,
    });
    expect(markdown).toContain("# 视频标题");
    expect(markdown).toContain("视频名称：视频标题");
    expect(markdown).toContain("BVID：BV1uv411q7Mv");
    expect(markdown).toContain("模型：MiniMax-M3");
    expect(markdown).toContain("MiniMax 文件：mm_file://file-1");
    expect(markdown).toContain("## 模型思考");
    expect(markdown).toContain("> M3 reasoning");
    expect(markdown).toContain("## 视频内容描述");
    expect(markdown).toContain("M3 描述。");
  });

  it("renders markdown for reused MiniMax files without bilibili metadata", () => {
    const markdown = transcriptToMarkdown({
      title: "复用 MiniMax 文件",
      video: {
        bvid: "MM_FILE",
        aid: 0,
        cid: 0,
        pageIndex: 0,
        pageTitle: "MiniMax 文件",
        link: "mm_file://file-reused",
        duration: 0,
      },
      model: "MiniMax-M3",
      question: "讲了什么",
      promptSeconds: 30,
      transcript: "直接复用 MiniMax 文件输出。",
      fileId: "file-reused",
      knowledgeWritten: true,
      dryRun: false,
    });
    expect(markdown).toContain("链接： mm_file://file-reused");
    expect(markdown).toContain("MiniMax 文件：mm_file://file-reused");
  });

  it("falls back to a placeholder when the transcript is empty", () => {
    const markdown = transcriptToMarkdown({
      title: "Fixture",
      video: {
        bvid: "BV1uv411q7Mv",
        aid: 1,
        cid: 2,
        pageIndex: 0,
        link: "https://www.bilibili.com/video/BV1uv411q7Mv",
        duration: 30,
      },
      model: "MiniMax-M3",
      question: "讲了什么",
      promptSeconds: 30,
      transcript: "",
      fileId: "file-1",
      knowledgeWritten: false,
      dryRun: true,
    });
    expect(markdown).toContain("（MiniMax 未返回描述）");
    expect(markdown).toContain("dry-run 模式下");
  });

  it("uses bvid + real cid when requesting Bilibili playurl for newer BV ids", async () => {
    const playUrl = createBilibiliPlayUrl({
      bvid: "BV1pGdwBEE7W",
      aid: 116532696909570,
      cid: 38160042847,
      quality: 32,
    });
    const url = new URL(playUrl);
    expect(url.searchParams.get("bvid")).toBe("BV1pGdwBEE7W");
    expect(url.searchParams.get("avid")).toBe("116532696909570");
    expect(url.searchParams.get("cid")).toBe("38160042847");
    expect(url.searchParams.get("qn")).toBe("32");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input));
      expect(requestUrl.searchParams.get("bvid")).toBe("BV1pGdwBEE7W");
      expect(requestUrl.searchParams.get("avid")).toBe("116532696909570");
      expect(requestUrl.searchParams.get("cid")).toBe("38160042847");
      expect(readHeaders(init?.headers).cookie).toContain("SESSDATA=sess");
      return new Response(JSON.stringify({ code: 0, data: { dash: { video: [], audio: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(fetchBilibiliDownloadUrl({
      bvid: "BV1pGdwBEE7W",
      aid: 116532696909570,
      cid: 38160042847,
      quality: 32,
      credential: { sessdata: "sess", biliJct: "csrf", buvid3: "buvid" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toEqual({ dash: { video: [], audio: [] } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the real aid/cid from video metadata instead of relying on local BV conversion", () => {
    const info = normalizeVideoInfo({
      rawInfo: {
        bvid: "BV1pGdwBEE7W",
        aid: 116532696909570,
        title: "不用养号也能印钞你学不学？",
        pages: [{ cid: 38160042847, duration: 153, part: "P1" }],
      },
      rawPages: [],
      bvid: "BV1pGdwBEE7W",
      link: "https://www.bilibili.com/video/BV1pGdwBEE7W",
      pageIndex: 0,
    });
    expect(info.aid).toBe(116532696909570);
    expect(info.cid).toBe(38160042847);
    expect(info.pageIndex).toBe(0);
  });

  it("prefers the smaller modern codec stream for MiniMax uploads by default", () => {
    const streams = [
      { id: 32, codecid: 7, codecs: "avc1.64001F", bandwidth: 777661 },
      { id: 32, codecid: 12, codecs: "hev1.1.6.L120.90", bandwidth: 414861 },
      { id: 32, codecid: 13, codecs: "av01.0.00M.10.0.110.01.01.01.0", bandwidth: 409831 },
      { id: 16, codecid: 7, codecs: "avc1.64001E", bandwidth: 568356 },
    ];

    // BV1ewVS6wE76 reproduced a MiniMax 422 sensitive rejection on
    // the AVC stream while the Python reference downloader's AV1 stream passed.
    expect(pickBestVideoStream(streams, { maxQuality: 32, videoCodec: "auto" })).toMatchObject({
      codecid: 13,
      codecs: expect.stringContaining("av01"),
    });
    expect(pickBestVideoStream(streams, { maxQuality: 32, videoCodec: "h264" })).toMatchObject({
      codecid: 7,
      codecs: expect.stringContaining("avc1"),
    });
  });

  it("normalizes invalid codec preferences back to auto", () => {
    expect(parseVideoCodecPreference("av1")).toBe("av1");
    expect(parseVideoCodecPreference("HEVC")).toBe("hevc");
    expect(parseVideoCodecPreference("h264")).toBe("h264");
    expect(parseVideoCodecPreference("vp9")).toBe("auto");
    expect(parseVideoCodecPreference(undefined)).toBe("auto");
  });
});

describe("deltaforce-bilibili-collect workflow runtime", () => {
  it("writes knowledge through PersistentValue on mocked real runs", async () => {
    const persistentValueStore = createMemoryKVStore();
    const report = await runWithMockEnv({
      args: [
        "--video-url",
        "https://www.bilibili.com/video/BV1uv411q7Mv",
        "--question",
        "讲了什么",
        "--document-title",
        "Mock M3 Real Run",
      ],
      persistentValueStore,
      env: {
        DELTAFORCE_BILIBILI_DOWNLOAD_MOCK: "1",
        MINIMAX_DRY_RUN: "1",
      },
    });

    if (report.status !== "success" || !report.result.ok) {
      throw new Error(`workflow failed (status=${report.status}): result=${JSON.stringify(report.result, null, 2)}`);
    }
    const output = readOutputPayload((report.result.data as { output: unknown }).output);
    expect(output.knowledgeWritten).toBe(true);
    expect(output.model).toBe("MiniMax-M3");
    expect(output.fileId).toBe("dry-run");
    expect(output.transcriptLength).toBeGreaterThan(0);
    expect(output.items).toHaveLength(2);
    expect(output.items[0]?.content).toContain("开始下载视频");
    expect(output.items[1]).toMatchObject({
      title: "Output",
      contentType: "text",
    });
    expect(output.items[1]?.iconPreset).toBeUndefined();
    expect(output.items[1]?.collapsed).toBeUndefined();
    expect(String(output.items[1]?.content)).toContain("这是一段离线 fixture 描述。");
    const documentId = String(output.documentId);
    const stored = persistentValueStore.records.get(
      `persistent_value:project:e48aae56-7e59-45f5-adc3-f30e9c65d23c::knowledge.document.${documentId}`,
    );
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      id: documentId,
      title: "Mock M3 Real Run",
    });
    expect(stored?.markdown).toContain("这是一段离线 fixture 描述。");
  });

  it("uses dry-run mode without network and skips knowledge write", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const persistentValueStore = createMemoryKVStore();
    const report = await runWithMockEnv({
      args: [
        "--dry-run",
        "--video-url",
        "https://www.bilibili.com/video/BV1uv411q7Mv",
        "--document-title",
        "Dry Run Preview",
      ],
      persistentValueStore,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    if (report.status !== "success" || !report.result.ok) {
      throw new Error(`workflow failed (status=${report.status}): result=${JSON.stringify(report.result, null, 2)}`);
    }
    const output = readOutputPayload((report.result.data as { output: unknown }).output);
    expect(output.knowledgeWritten).toBe(false);
    expect(output.dryRun).toBe(true);
    expect(output.fileId).toBe("dry-run");
    expect(persistentValueStore.records.size).toBe(0);
  });

  it("exercises the real minimax client with a stubbed global fetch", async () => {
    const persistentValueStore = createMemoryKVStore();
    const fetchMock = createMinimaxFetchMock({
      uploadFileId: "remote-file-1",
      transcript: "远端 MiniMax M3 输出 fixture。",
    });
    vi.stubGlobal("fetch", fetchMock);
    const report = await runWithMockEnv({
      args: [
        "--video-url",
        "https://www.bilibili.com/video/BV1uv411q7Mv",
        "--question",
        "讲了什么",
        "--document-title",
        "Remote M3 Run",
      ],
      persistentValueStore,
      env: {
        DELTAFORCE_BILIBILI_DOWNLOAD_MOCK: "1",
        MINIMAX_API_KEY: "test-key",
      },
    });

    if (report.status !== "success" || !report.result.ok) {
      throw new Error(`workflow failed (status=${report.status}): result=${JSON.stringify(report.result, null, 2)}`);
    }
    const fetchCalls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(fetchCalls.some((url) => url.includes("/files/upload"))).toBe(true);
    expect(fetchCalls.some((url) => url.includes("/chat/completions"))).toBe(true);
    const output = readOutputPayload((report.result.data as { output: unknown }).output);
    expect(output.knowledgeWritten).toBe(true);
    expect(output.fileId).toBe("remote-file-1");
    expect(output.transcriptLength).toBeGreaterThan(0);
    const stored = persistentValueStore.records.get(
      `persistent_value:project:e48aae56-7e59-45f5-adc3-f30e9c65d23c::knowledge.document.${output.documentId}`,
    );
    expect(stored?.markdown).toContain("远端 MiniMax M3 输出 fixture。");
  });

  it("streams in-progress output chunks between collection steps", async () => {
    const persistentValueStore = createMemoryKVStore();
    const chunks: string[] = [];
    const report = await runWithMockEnv({
      args: [
        "--video-url",
        "https://www.bilibili.com/video/BV1uv411q7Mv",
        "--question",
        "讲了什么",
        "--document-title",
        "Streaming Progress Run",
      ],
      persistentValueStore,
      env: {
        DELTAFORCE_BILIBILI_DOWNLOAD_MOCK: "1",
        MINIMAX_DRY_RUN: "1",
      },
      onRuntimeEvent(event) {
        if (event.type !== "node_chunk" || event.nodeName !== "output") {
          return;
        }
        if (typeof event.chunk === "string") {
          chunks.push(event.chunk);
        } else if (
          isRecord(event.chunk) &&
          event.chunk.type === "output_item_delta" &&
          typeof event.chunk.delta === "string"
        ) {
          chunks.push(event.chunk.delta);
        }
      },
    });

    if (report.status !== "success" || !report.result.ok) {
      throw new Error(`workflow failed (status=${report.status}): result=${JSON.stringify(report.result, null, 2)}`);
    }
    expect(chunks.join("")).toContain("开始下载视频");
    expect(chunks.join("")).toContain("下载完成");
    expect(chunks.join("")).toContain("开始上传到 MiniMax");
    expect(chunks.join("")).toContain("上传完成");
    expect(chunks.join("")).toContain("开始请求 MiniMax M3");
    expect(chunks.join("")).toContain("MiniMax 理解完成");
    expect(chunks.join("")).toContain("知识库写入完成");
  });

  it("reuses mm_file and skips bilibili download/upload", async () => {
    const persistentValueStore = createMemoryKVStore();
    const fetchMock = createMinimaxFetchMock({
      uploadFileId: "should-not-be-used",
      transcript: "复用 mm_file 的理解结果。",
    });
    vi.stubGlobal("fetch", fetchMock);
    const report = await runWithMockEnv({
      args: [
        "--mm-file",
        "reused-file-1",
        "--question",
        "讲了什么",
        "--document-title",
        "Reuse Existing MiniMax File",
      ],
      persistentValueStore,
      env: {
        MINIMAX_API_KEY: "test-key",
      },
    });

    if (report.status !== "success" || !report.result.ok) {
      throw new Error(`workflow failed (status=${report.status}): result=${JSON.stringify(report.result, null, 2)}`);
    }
    const fetchCalls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(fetchCalls.some((url) => url.includes("/files/upload"))).toBe(false);
    expect(fetchCalls.some((url) => url.includes("/chat/completions"))).toBe(true);
    const output = readOutputPayload((report.result.data as { output: unknown }).output);
    expect(output.fileId).toBe("reused-file-1");
    expect(output.videoUrl).toBe("mm_file://reused-file-1");
    expect(output.bvid).toBe("MM_FILE");
    expect(output.items[0]?.content).toContain("跳过 B 站下载和 MiniMax 上传");
  });

  it("rejects runs when both videoUrl and mm_file are missing", async () => {
    const report = await runWithMockEnv({
      args: [
        "--question",
        "讲了什么",
      ],
    });

    expect(report.status).toBe("failed");
    expect(JSON.stringify(report.result, null, 2)).toContain("videoUrl 与 mm_file 必须二选一填写");
  });

  it("keeps streamed progress and appends the final transcript as plain text output", async () => {
    const persistentValueStore = createMemoryKVStore();
    const report = await runWithMockEnv({
      args: [
        "--dry-run",
        "--video-url",
        "https://www.bilibili.com/video/BV1uv411q7Mv",
        "--question",
        "讲了什么",
        "--document-title",
        "Plain Text Output",
      ],
      persistentValueStore,
    });

    if (report.status !== "success" || !report.result.ok) {
      throw new Error(`workflow failed (status=${report.status}): result=${JSON.stringify(report.result, null, 2)}`);
    }
    const output = readOutputPayload((report.result.data as { output: unknown }).output);
    expect(output.items).toHaveLength(2);
    expect(output.items[0]).toMatchObject({
      title: "Output",
      contentType: "markdown",
      collapsed: false,
    });
    expect(String(output.items[0]?.content)).toContain("开始解析 B 站视频");
    expect(String(output.items[0]?.content)).toContain("执行结果已生成");
    expect(output.items[1]).toMatchObject({
      title: "Output",
      contentType: "text",
      content: expect.stringContaining("## 视频内容描述"),
    });
    expect(output.items[1]?.iconPreset).toBeUndefined();
    expect(output.items[1]?.metadata).toBeUndefined();
  });
});

async function runWithMockEnv(options: {
  args: string[];
  persistentValueStore?: KVStore;
  env?: Record<string, string>;
  onRuntimeEvent?(event: RuntimeEvent): Promise<void> | void;
}) {
  const kvStoreDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-bilibili-test-"));
  try {
    return await runLocalWorkflowWithReport({
      workflowDir: path.resolve(process.cwd(), "workflow/deltaforce-bilibili-collect"),
      workflowName: "deltaforce-bilibili-collect",
      args: options.args,
      env: {
        ...process.env,
        ...options.env,
      },
      storage: {
        host: "local",
        local: {
          kvStoreDir,
          persistentValueStore: options.persistentValueStore,
        },
      },
      fileStore: createMemoryFileStore(),
      maxNodeExecutions: 20,
      onRuntimeEvent: options.onRuntimeEvent,
    });
  } finally {
    await rm(kvStoreDir, { recursive: true, force: true });
  }
}

function createMinimaxFetchMock(options: { uploadFileId: string; transcript: string }): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/files/upload")) {
      return new Response(JSON.stringify({ file: { file_id: options.uploadFileId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/chat/completions")) {
      const body = init?.body;
      const payload = typeof body === "string" ? body : body ? body.toString() : "";
      expect(payload).toContain("mm_file://");
      const lines = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: options.transcript } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(lines.join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

function readOutputPayload(value: unknown): DeltaforceBilibiliCollectOutputPayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected workflow output payload.");
  }
  return value as DeltaforceBilibiliCollectOutputPayload;
}

function splitInHalf(value: string): { first: string; second: string } {
  const mid = Math.floor(value.length / 2);
  return { first: value.slice(0, mid), second: value.slice(mid) };
}

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
    },
  });
}

function readHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

interface MemoryRecord {
  id: string;
  title: string;
  markdown: string;
}

function createMemoryKVStore(): KVStore & { records: Map<string, MemoryRecord> } {
  const records = new Map<string, MemoryRecord>();
  const namespaceTails = new Map<string, Promise<void>>();
  const compositeKey = (input: { storageKind: string; scope: string; projectId: string; conversationId?: string; key: string }): string =>
    [input.storageKind, input.scope, input.projectId, input.conversationId ?? "", input.key].join(":");
  const store: KVStore & { records: Map<string, MemoryRecord> } = {
    records,
    async getValue(input) {
      return records.get(compositeKey(input)) as MemoryRecord | undefined;
    },
    async setValue(input) {
      records.set(compositeKey(input), input.value as MemoryRecord);
    },
    async updateValue(input, updater) {
      const entryKey = compositeKey(input);
      const next = updater(records.get(entryKey)) as MemoryRecord;
      records.set(entryKey, next);
      return next;
    },
    async withNamespaceLock(input, operation) {
      const namespace = [input.storageKind, input.scope, input.projectId, input.conversationId ?? ""].join(":");
      const previous = namespaceTails.get(namespace) ?? Promise.resolve();
      let release!: () => void;
      const completion = new Promise<void>((resolve) => {
        release = resolve;
      });
      namespaceTails.set(namespace, completion);
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
  return store;
}

function createMemoryFileStore() {
  const files = new Map<string, { name: string; mimeType?: string; buffer: Buffer }>();
  let counter = 0;
  return {
    async createFile(input: { name: string; mimeType?: string; buffer: Buffer | Uint8Array | string }): Promise<{ id: string; name: string; url: string }> {
      const id = `file-${++counter}`;
      const buffer = Buffer.isBuffer(input.buffer)
        ? input.buffer
        : typeof input.buffer === "string"
          ? Buffer.from(input.buffer)
          : Buffer.from(input.buffer);
      files.set(id, { name: input.name, mimeType: input.mimeType, buffer });
      return { id, name: input.name, url: `/api/workflows/files/${encodeURIComponent(id)}` };
    },
    resolveFile: (id: string) => files.get(id),
  };
}
