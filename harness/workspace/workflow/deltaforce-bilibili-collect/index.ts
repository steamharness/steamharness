/**
 * deltaforce-bilibili-collect workflow
 *
 *  rewritten to ask MiniMax M3 for a video understanding of a
 * Bilibili video, replacing the old frame/subtitle timeline pipeline.
 *
 * Pipeline:
 *   input → output stream (download → upload → understand → knowledge write)
 *
 * The slow collection steps live in the output stream so App/Web can render
 * progress chunks while the run is still executing.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BilibiliCredentialConfig,
  BilibiliDownloadResult,
  DeltaforceBilibiliCollectContext,
  DeltaforceBilibiliCollectDocument,
  DeltaforceBilibiliCollectInput,
  DeltaforceBilibiliCollectOutputPayload,
  DeltaforceBilibiliCollectParsedInput,
  ServerUploadConfig,
} from "./interface";
import { parseBilibiliVideoLink } from "./lib/link";
import {
  clampPositiveInteger,
  normalizeOptionalPositiveInteger,
  readString,
} from "./lib/values";
import { mmFileReference } from "./lib/minimax";
import {
  cleanupDownloadedVideo,
  createDocumentFromCollectStages,
  runDownload,
  runUnderstand,
  runUpload,
} from "./nodes/collect";
import { createOutputPayloadFromDocument } from "./nodes/output";

const STEAMHARNESS_NAME = "deltaforce-bilibili-collect";
const DEFAULT_VIDEO_URL = "https://www.bilibili.com/video/BV1uv411q7Mv";
const DEFAULT_QUESTION = "请详细描述这个视频里发生了什么";
const DEFAULT_MODEL = "MiniMax-M3";
const DEFAULT_MAX_TOKENS = 524288;
const DEFAULT_QUALITY = 32;
const DEFAULT_VIDEO_CODEC = "auto";
const DEFAULT_MAX_DURATION = 300;
const DEFAULT_OUTPUT_DIR = join(tmpdir(), "deltaforce-bilibili-collect");
const PROGRESS_ITEM_ID = "deltaforce-bilibili-collect-progress";
const runDocuments = new WeakMap<DeltaforceBilibiliCollectParsedInput, DeltaforceBilibiliCollectDocument>();

const inputNode = steamharness.createInputNode<DeltaforceBilibiliCollectInput, DeltaforceBilibiliCollectParsedInput>({
  name: "deltaforce-bilibili-collect-input",
  parse(input) {
    try {
      // support either a Bilibili URL or an existing MiniMax file id.
      const mmFile = normalizeMmFile(input.mm_file);
      const rawVideoUrl = normalizeOptionalText(input.videoUrl);
      if ((mmFile === undefined && rawVideoUrl === undefined) || (mmFile !== undefined && rawVideoUrl !== undefined)) {
        throw new Error("videoUrl 与 mm_file 必须二选一填写。");
      }
      const parsed = mmFile === undefined ? parseBilibiliVideoLink(rawVideoUrl ?? DEFAULT_VIDEO_URL) : undefined;
      return {
        errCode: 0,
        errMessage: "",
        videoUrl: parsed?.normalizedUrl,
        bvid: parsed?.bvid,
        mmFile,
        question: normalizeOptionalText(input.question) ?? DEFAULT_QUESTION,
        model: normalizeOptionalText(input.model) ?? DEFAULT_MODEL,
        maxTokens: normalizeOptionalPositiveInteger(input.maxTokens, "maxTokens") ?? DEFAULT_MAX_TOKENS,
        quality: clampPositiveInteger(input.quality, DEFAULT_QUALITY, { min: 16, max: 120, name: "quality" }),
        videoCodec: normalizeVideoCodec(input.videoCodec),
        maxDuration: parseIntMaxDuration(input.maxDuration),
        outputDir: normalizeOptionalText(input.outputDir) ?? DEFAULT_OUTPUT_DIR,
        keepVideo: input.keepVideo === true,
        pageIndex: clampPositiveInteger(input.pageIndex, 1, { min: 1, name: "pageIndex" }) - 1,
        documentTitle: normalizeOptionalText(input.documentTitle),
        documentId: normalizeOptionalText(input.documentId),
        dryRun: input.dryRun === true,
        mockDownloader: input.mockDownloader,
        mockUploader: input.mockUploader,
        mockUnderstander: input.mockUnderstander,
        fetchImpl: input.fetchImpl,
      };
    } catch (error) {
      throw new steamharness.HarnessError({
        type: "input_validation",
        message: error instanceof Error ? error.message : String(error),
        nodeName: "deltaforce-bilibili-collect-input",
      });
    }
  },
});

// Keep the whole slow collect/write pipeline in an output stream node
// so the UI receives visible node_chunk events between every major step.
const outputNode = steamharness.createOutputNode<DeltaforceBilibiliCollectParsedInput, DeltaforceBilibiliCollectOutputPayload>({
  name: "deltaforce-bilibili-collect-output",
  async *stream(input, context) {
    const runtimeContext = context as DeltaforceBilibiliCollectContext;
    let download: BilibiliDownloadResult | undefined;

    try {
      // The App keeps live output items while merging the final
      // report. Stream progress with a stable item id so it updates in place.
      yield createProgressStartChunk();
      let upload;
      if (input.mmFile !== undefined) {
        // reuse an existing MiniMax file id and skip the Bilibili pipeline.
        yield createProgressDeltaChunk(`检测到 MiniMax 文件：${mmFileReference(input.mmFile)}。`);
        yield createProgressDeltaChunk("跳过 B 站下载和 MiniMax 上传，直接复用现有文件。");
        upload = { fileId: input.mmFile, raw: { reused: true } };
      } else {
        yield createProgressDeltaChunk(`开始解析 B 站视频：${input.videoUrl}`);
        yield createProgressDeltaChunk(`开始下载视频，清晰度上限 qn=${input.quality}。`);
        download = await runDownload(input, runtimeContext);
        if (download.trimmedSeconds !== undefined && download.trimmedSeconds > 0) {
          yield createProgressDeltaChunk(
            `⚠ 视频时长 ${formatDuration(download.info.duration)} 超过上限 ${formatDuration(input.maxDuration)}，已自动截取前 ${formatDuration(download.trimmedSeconds)} 进行理解。可通过 --max-duration 调整上限（设为 0 禁用截取）。`,
          );
        }
        yield createProgressDeltaChunk(
          `下载完成：${download.info.title}（${formatBytes(download.size)}，BVID ${download.info.bvid}）。`,
        );

        yield createProgressDeltaChunk("开始上传到 MiniMax，用于 M3 视频理解。");
        upload = await runUpload(input, runtimeContext, download.localVideoPath);
        yield createProgressDeltaChunk(`上传完成：${mmFileReference(upload.fileId)}。`);
      }

      yield createProgressDeltaChunk(`开始请求 MiniMax M3 理解视频，问题：${input.question}`);
      const understand = await runUnderstand(input, runtimeContext, mmFileReference(upload.fileId));
      yield createProgressDeltaChunk(
        `MiniMax 理解完成：生成 ${understand.transcript.length} 字，模型 ${understand.model}。`,
      );

      let document = await createDocumentFromCollectStages(input, download, upload, understand);
      if (input.dryRun) {
        yield createProgressDeltaChunk("dry-run 模式：跳过知识库写入，只生成预览结果。");
      } else {
        yield createProgressDeltaChunk(`开始写入知识库文档：${document.documentId}。`);
        const existing = await context.databases.get("data").knowledge.getDocument(document.documentId);
        if (existing === undefined) {
          await context.databases.get("data").knowledge.createDocument({
            id: document.documentId,
            title: document.documentTitle,
            markdown: document.markdown,
          });
        } else {
          await context.databases.get("data").knowledge.editDocument({
            id: document.documentId,
            title: document.documentTitle,
            markdown: document.markdown,
          });
        }
        document = {
          ...document,
          knowledgeWritten: true,
        };
        yield createProgressDeltaChunk(`知识库写入完成：${document.documentId}。`);
      }

      runDocuments.set(input, document);
      yield createProgressDeltaChunk(`执行结果已生成：${document.documentTitle}。`);
      yield steamharness.createOutputItemChunk({
        type: "output_item_end",
        itemId: PROGRESS_ITEM_ID,
      });
    } catch (error) {
      yield createProgressDeltaChunk(`执行失败：${error instanceof Error ? error.message : String(error)}`);
      yield steamharness.createOutputItemChunk({
        type: "output_item_end",
        itemId: PROGRESS_ITEM_ID,
      });
      throw error;
    } finally {
      if (download !== undefined) {
        await cleanupDownloadedVideo(input, download);
      }
    }
  },
  format(stream, input) {
    return createOutputPayloadFromDocument(requireDocument(runDocuments.get(input)), stream.items);
  },
});

export const deltaforceBilibiliCollectProject = steamharness.defineProject<DeltaforceBilibiliCollectInput, DeltaforceBilibiliCollectOutputPayload>({
  name: STEAMHARNESS_NAME,
  async run(input, context) {
    const parsed = await steamharness.runNode(inputNode, input, context);
    const output = await steamharness.runStreamNode(outputNode, parsed, context);
    return requireOutput(output.output);
  },
});

export const executor = steamharness.defineExecutor<
  DeltaforceBilibiliCollectInput,
  DeltaforceBilibiliCollectOutputPayload
>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    steamharness.defineEntrypoint<
      DeltaforceBilibiliCollectInput,
      DeltaforceBilibiliCollectOutputPayload
    >({
      id: "main",
      title: "Bilibili Collect",
      workflow: deltaforceBilibiliCollectProject,
      registry: [
        { name: "collect-input", node: inputNode },
        { name: "collect-progress-output", node: outputNode, stream: true },
      ],
      params: [
        {
          name: "videoUrl",
          flag: "--video-url",
          type: "positional",
          required: false,
          defaultValue: "",
          description:
            "Optional Bilibili BV id or video URL. Required when mm_file is empty.",
        },
        {
          name: "mm_file",
          flag: "--mm-file",
          type: "string",
          required: false,
          defaultValue: "",
          description:
            "Optional MiniMax file id. When set, skip Bilibili download/upload and understand this file directly.",
        },
        {
          name: "question",
          flag: "--question",
          type: "string",
          required: true,
          defaultValue: "",
          description: "Question to ask MiniMax M3 about the video.",
        },
        {
          kind: "auxiliary",
          id: "advanced",
          label: "Advanced",
          fields: [
            {
              name: "model",
              flag: "--model",
              type: "string",
              required: false,
              defaultValue: "MiniMax-M3",
              description: "MiniMax model name (default MiniMax-M3).",
            },
            {
              name: "maxTokens",
              flag: "--max-tokens",
              type: "number",
              required: false,
              defaultValue: "524288",
              description: "Max output tokens for the M3 response.",
            },
            {
              name: "quality",
              flag: "--quality",
              type: "number",
              required: false,
              defaultValue: "32",
              description:
                "Bilibili qn quality cap. 16/32/64/80/112/116/120. Default 32 (480P).",
            },
            {
              name: "videoCodec",
              flag: "--video-codec",
              type: "string",
              required: false,
              defaultValue: "auto",
              control: "select",
              options: [
                { label: "Auto", value: "auto" },
                { label: "AV1", value: "av1" },
                { label: "HEVC", value: "hevc" },
                { label: "H.264", value: "h264" },
              ],
              description:
                "Preferred Bilibili DASH video codec. Auto favors AV1/HEVC for smaller MiniMax uploads.",
            },
            {
              name: "maxDuration",
              flag: "--max-duration",
              type: "number",
              required: false,
              defaultValue: String(DEFAULT_MAX_DURATION),
              description:
                "Maximum video duration in seconds to send to MiniMax. Longer videos are auto-trimmed. Set to 0 to disable trimming.",
            },
            {
              name: "outputDir",
              flag: "--output",
              type: "string",
              required: false,
              description: "Directory to temporarily store the downloaded video.",
            },
            {
              name: "keepVideo",
              flag: "--keep-video",
              type: "boolean",
              required: false,
              defaultValue: "false",
              description:
                "Keep the downloaded video after upload instead of removing it.",
            },
            {
              name: "pageIndex",
              flag: "--page-index",
              type: "number",
              required: false,
              defaultValue: "1",
              description: "1-based Bilibili part index. Default 1.",
            },
            {
              name: "documentTitle",
              flag: "--document-title",
              type: "string",
              required: false,
              description: "Optional knowledge document title.",
            },
            {
              name: "documentId",
              flag: "--document-id",
              type: "string",
              required: false,
              description: "Optional stable knowledge document id.",
            },
            {
              name: "dryRun",
              flag: "--dry-run",
              type: "boolean",
              required: false,
              defaultValue: "false",
              description:
                "Skip B 站 / MiniMax network calls; use offline fixture data and skip knowledge write.",
            }
          ],
        },
      ],
      createInput({ args }) {
        return parseInputArgs(args);
      },
      createContext({ config, projectName, conversationId }) {
        return {
          metadata: {
            bilibiliCredential: readBilibiliCredential(config),
            minimaxApiKey: readString(
              config.MINIMAX_API_KEY ?? config.MINIMAX_VIDEO_API_KEY,
            ),
            minimaxBaseUrl: readString(config.MINIMAX_BASE_URL),
            serverUpload: readServerUploadConfig(
              config,
              projectName,
              conversationId,
            ),
            bilibiliDownloadMock: config.DELTAFORCE_BILIBILI_DOWNLOAD_MOCK === "1",
            minimaxDryRun:
              config.MINIMAX_DRY_RUN === "1" ||
              config.DELTAFORCE_BILIBILI_COLLECT_DRY_RUN === "1",
          },
        };
      },
    }),
  ],
});

export { deltaforceBilibiliCollectProject as workflow };
export default deltaforceBilibiliCollectProject;

function parseInputArgs(args: string[]): DeltaforceBilibiliCollectInput {
  let videoUrl = "";
  let mm_file: string | undefined;
  let question: string | undefined;
  let model: string | undefined;
  let maxTokens: number | undefined;
  let quality: number | undefined;
  let videoCodec: string | undefined;
  let maxDuration: number | undefined;
  let outputDir: string | undefined;
  let keepVideo = false;
  let pageIndex: number | undefined;
  let documentTitle: string | undefined;
  let documentId: string | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--video-url") {
      videoUrl = readArgValue(args, ++index, arg);
      continue;
    }
    if (arg === "--mm-file") {
      mm_file = readArgValue(args, ++index, arg);
      continue;
    }
    if (arg === "--question") {
      question = readArgValue(args, ++index, arg);
      continue;
    }
    if (arg === "--model") {
      model = readArgValue(args, ++index, arg);
      continue;
    }
    if (arg === "--max-tokens") {
      maxTokens = Number(readArgValue(args, ++index, arg));
      continue;
    }
    if (arg === "--quality") {
      quality = Number(readArgValue(args, ++index, arg));
      continue;
    }
    if (arg === "--video-codec") {
      videoCodec = readArgValue(args, ++index, arg);
      continue;
    }
    if (arg === "--max-duration") {
      maxDuration = Number(readArgValue(args, ++index, arg));
      continue;
    }
    if (arg === "--output") {
      outputDir = readArgValue(args, ++index, arg);
      continue;
    }
    if (arg === "--keep-video") {
      keepVideo = true;
      continue;
    }
    if (arg === "--page-index") {
      pageIndex = Number(readArgValue(args, ++index, arg));
      continue;
    }
    if (arg === "--document-title") {
      documentTitle = readArgValue(args, ++index, arg);
      continue;
    }
    if (arg === "--document-id") {
      documentId = readArgValue(args, ++index, arg);
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (videoUrl === "") {
      videoUrl = arg;
    }
  }

  return {
    videoUrl: videoUrl || undefined,
    mm_file,
    question,
    model,
    maxTokens,
    quality,
    videoCodec,
    maxDuration,
    outputDir,
    keepVideo,
    pageIndex,
    documentTitle,
    documentId,
    dryRun,
  };
}

function readArgValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function readBilibiliCredential(config: Record<string, any>): BilibiliCredentialConfig {
  return {
    sessdata: normalizeOptionalText(config.BILIBILI_SESSDATA ?? config.SESSDATA),
    biliJct: normalizeOptionalText(config.BILIBILI_BILI_JCT ?? config.BILI_JCT ?? config.bili_jct),
    buvid3: normalizeOptionalText(config.BILIBILI_BUVID3),
  };
}

function readServerUploadConfig(
  config: Record<string, any>,
  projectName: string,
  conversationId: string | undefined,
): ServerUploadConfig {
  return {
    projectName,
    conversationId,
  };
}

function normalizeOptionalText(value: unknown): string | undefined {
  const text = readString(value)?.trim();
  return text === undefined || text === "" ? undefined : text;
}

function normalizeMmFile(value: unknown): string | undefined {
  const text = normalizeOptionalText(value);
  if (text === undefined) {
    return undefined;
  }
  return text.replace(/^mm_file:\/\//, "").trim() || undefined;
}

function normalizeVideoCodec(value: unknown): "auto" | "av1" | "hevc" | "h264" {
  const text = normalizeOptionalText(value)?.toLowerCase();
  if (text === "av1" || text === "hevc" || text === "h264") {
    return text;
  }
  return DEFAULT_VIDEO_CODEC;
}

function parseIntMaxDuration(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_DURATION;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  return DEFAULT_MAX_DURATION;
}

function requireOutput(output: DeltaforceBilibiliCollectOutputPayload | undefined): DeltaforceBilibiliCollectOutputPayload {
  if (output === undefined) {
    throw new steamharness.HarnessError({
      type: "execution",
      message: "deltaforce-bilibili-collect output was not created.",
    });
  }
  return output;
}

function requireDocument(document: DeltaforceBilibiliCollectDocument | undefined): DeltaforceBilibiliCollectDocument {
  if (document === undefined) {
    throw new steamharness.HarnessError({
      type: "execution",
      message: "deltaforce-bilibili-collect document was not created.",
      nodeName: "deltaforce-bilibili-collect-output",
    });
  }
  return document;
}

function createProgressStartChunk() {
  return steamharness.createOutputItemChunk({
    type: "output_item_start",
    item: {
      id: PROGRESS_ITEM_ID,
      title: "Output",
      content: "",
      contentType: "markdown",
      collapsed: false,
    },
  });
}

function createProgressDeltaChunk(content: string) {
  return steamharness.createOutputItemChunk({
    type: "output_item_delta",
    itemId: PROGRESS_ITEM_ID,
    delta: `${content}\n`,
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) {
    return secs > 0 ? `${minutes}min${secs}s` : `${minutes}min`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h${mins}min` : `${hours}h`;
}
