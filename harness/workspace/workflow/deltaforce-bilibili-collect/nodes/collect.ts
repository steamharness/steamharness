/**
 * Three-step pipeline: download Bilibili video → upload to MiniMax → ask M3.
 *
 *  phase four replaced the old screenshot/subtitle flow with a single
 * pass through MiniMax M3 video understanding; the workflow hands the model a
 * `mm_file://{file_id}` reference and stores the streamed description as a
 * PersistentValue-backed knowledge document.
 */

import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { downloadBilibiliVideo, parseQuality, parseVideoCodecPreference } from "../lib/bilibili";
import {
  createDryRunDownloadResult,
  createDryRunUnderstandResult,
  createDryRunUploadResult,
  shouldUseDryRunDownload,
  shouldUseDryRunUnderstand,
} from "../lib/mock";
import {
  DEFAULT_MINIMAX_BASE_URL,
  MinimaxClient,
  mmFileReference,
  readMinimaxApiKey,
  readMinimaxApiKeyFromMetadata,
  readMinimaxBaseUrl,
} from "../lib/minimax";
import { transcriptToMarkdown } from "../lib/transcript";
import { sanitizeFileSegment } from "../lib/values";
import type {
  BilibiliDownloadResult,
  BilibiliVideoInfo,
  DeltaforceBilibiliCollectContext,
  DeltaforceBilibiliCollectDocument,
  DeltaforceBilibiliCollectParsedInput,
  MinimaxUploadResult,
  MinimaxUnderstandResult,
} from "../interface";

const PROMPT_SECONDS_RESERVED = 30;

export async function collectVideoDocument(
  input: DeltaforceBilibiliCollectParsedInput,
  context: DeltaforceBilibiliCollectContext,
): Promise<DeltaforceBilibiliCollectDocument> {
  const download = await runDownload(input, context);
  const upload = await runUpload(input, context, download.localVideoPath);
  const videoReference = mmFileReference(upload.fileId);
  const understand = await runUnderstand(input, context, videoReference);

  const document = await createDocumentFromCollectStages(input, download, upload, understand);
  await cleanupDownloadedVideo(input, download);
  return document;
}

export async function createDocumentFromCollectStages(
  input: DeltaforceBilibiliCollectParsedInput,
  download: BilibiliDownloadResult | undefined,
  upload: MinimaxUploadResult,
  understand: MinimaxUnderstandResult,
): Promise<DeltaforceBilibiliCollectDocument> {
  const info = resolveDocumentVideoInfo(input, download, upload.fileId);
  const documentTitle = (input.documentTitle?.trim() || info.title).trim();
  const documentId = createDocumentId({
    bvid: info.bvid,
    fileId: upload.fileId,
    title: documentTitle,
    pageIndex: input.pageIndex,
    explicitId: input.documentId,
  });
  const promptSeconds = clampSeconds(info.duration, PROMPT_SECONDS_RESERVED);

  const markdown = transcriptToMarkdown({
    title: documentTitle,
    video: {
      bvid: info.bvid,
      aid: info.aid,
      cid: info.cid,
      pageIndex: info.pageIndex,
      pageTitle: info.pageTitle,
      link: info.link,
      duration: info.duration,
    },
    model: understand.model,
    question: input.question,
    promptSeconds,
    transcript: understand.transcript,
    fileId: upload.fileId,
    knowledgeWritten: false,
    dryRun: input.dryRun,
  });

  return {
    errCode: 0,
    errMessage: "",
    info,
    transcript: understand.transcript,
    model: understand.model,
    fileId: upload.fileId,
    promptSeconds,
    markdown,
    documentId,
    documentTitle,
    knowledgeWritten: false,
    dryRun: input.dryRun,
  };
}

export async function cleanupDownloadedVideo(
  input: DeltaforceBilibiliCollectParsedInput,
  download: BilibiliDownloadResult,
): Promise<void> {
  if (!input.keepVideo && !input.dryRun && existsSync(download.localVideoPath)) {
    await rm(download.localVideoPath, { force: true });
  }
}

export function createDocumentId(input: {
  bvid: string;
  fileId: string;
  title: string;
  pageIndex: number;
  explicitId?: string;
}): string {
  if (input.explicitId !== undefined && input.explicitId.trim() !== "") {
    return normalizeDocumentId(input.explicitId);
  }
  const titlePart = sanitizeFileSegment(input.title || "video").slice(0, 48);
  const sourcePart = input.bvid === "MM_FILE"
    ? sanitizeFileSegment(input.fileId || "file").slice(0, 48) || "file"
    : input.bvid;
  return normalizeDocumentId([
    "bilibili",
    sourcePart,
    `p${input.pageIndex + 1}`,
    titlePart || "video",
  ].join("."));
}

function normalizeDocumentId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/g, "")
    .replace(/[^A-Za-z0-9]+$/g, "")
    .slice(0, 128);
  return normalized === "" ? "bilibili.video" : normalized;
}

function clampSeconds(duration: number, reserved: number): number {
  if (!Number.isFinite(duration) || duration <= 0) {
    return reserved;
  }
  return Math.max(reserved, Math.round(duration));
}

export async function runDownload(
  input: DeltaforceBilibiliCollectParsedInput,
  context: DeltaforceBilibiliCollectContext,
): Promise<Awaited<ReturnType<typeof downloadBilibiliVideo>>> {
  if (input.bvid === undefined || input.videoUrl === undefined) {
    throw new Error("videoUrl 未提供，无法执行 B 站下载。");
  }
  if (input.mockDownloader !== undefined) {
    return await input.mockDownloader(input, context);
  }
  if (shouldUseDryRunDownload(input, context)) {
    return await createDryRunDownloadResult(input);
  }
  return await downloadBilibiliVideo({
    bvid: input.bvid,
    videoUrl: input.videoUrl,
    pageIndex: input.pageIndex,
    outputDir: input.outputDir,
    keepVideo: input.keepVideo,
    quality: parseQuality(input.quality),
    videoCodec: parseVideoCodecPreference(input.videoCodec),
    maxDurationSeconds: input.maxDuration,
    credential: {
      sessdata: context.metadata?.bilibiliCredential?.sessdata,
      biliJct: context.metadata?.bilibiliCredential?.biliJct,
      buvid3: context.metadata?.bilibiliCredential?.buvid3,
    },
    signal: context.abortSignal,
    fetchImpl: input.fetchImpl,
  });
}

export async function runUpload(
  input: DeltaforceBilibiliCollectParsedInput,
  context: DeltaforceBilibiliCollectContext,
  localPath: string,
): Promise<MinimaxUploadResult> {
  if (input.mockUploader !== undefined) {
    return await input.mockUploader(localPath, { purpose: "video_understanding" }, context);
  }
  if (input.dryRun || context.metadata?.minimaxDryRun === true) {
    return createDryRunUploadResult(localPath, { purpose: "video_understanding" });
  }
  const apiKey = readMinimaxApiKeyFromMetadata(context.metadata) ?? readMinimaxApiKey();
  if (apiKey === undefined) {
    throw new Error(
      "Minimax upload requires MINIMAX_API_KEY. Set it in .env or pass --dry-run for offline mode.",
    );
  }
  const client = new MinimaxClient({
    apiKey,
    baseUrl: context.metadata?.minimaxBaseUrl ?? readMinimaxBaseUrl(),
    fetchImpl: input.fetchImpl,
  });
  return await client.uploadFile(localPath, { purpose: "video_understanding", signal: context.abortSignal });
}

export async function runUnderstand(
  input: DeltaforceBilibiliCollectParsedInput,
  context: DeltaforceBilibiliCollectContext,
  videoUrl: string,
): Promise<MinimaxUnderstandResult> {
  if (input.mockUnderstander !== undefined) {
    return await input.mockUnderstander(
      {
        videoUrl,
        question: input.question,
        model: input.model,
        maxTokens: input.maxTokens,
        signal: context.abortSignal,
      },
      context,
    );
  }
  if (shouldUseDryRunUnderstand(input, context)) {
    return createDryRunUnderstandResult({
      videoUrl,
      question: input.question,
      model: input.model,
      maxTokens: input.maxTokens,
      signal: context.abortSignal,
    });
  }
  const apiKey = readMinimaxApiKeyFromMetadata(context.metadata) ?? readMinimaxApiKey();
  if (apiKey === undefined) {
    throw new Error(
      "Minimax understand requires MINIMAX_API_KEY. Set it in .env or pass --dry-run for offline mode.",
    );
  }
  const client = new MinimaxClient({
    apiKey,
    baseUrl: context.metadata?.minimaxBaseUrl ?? DEFAULT_MINIMAX_BASE_URL,
    fetchImpl: input.fetchImpl,
  });
  return await client.understandVideo({
    videoUrl,
    question: input.question,
    model: input.model,
    maxTokens: input.maxTokens,
    signal: context.abortSignal,
  });
}

function resolveDocumentVideoInfo(
  input: DeltaforceBilibiliCollectParsedInput,
  download: BilibiliDownloadResult | undefined,
  fileId: string,
): BilibiliVideoInfo {
  if (download !== undefined) {
    return download.info;
  }
  return {
    bvid: "MM_FILE",
    aid: 0,
    cid: 0,
    pageIndex: 0,
    pageTitle: "MiniMax 文件",
    title: input.documentTitle?.trim() || `MiniMax File ${fileId}`,
    link: mmFileReference(fileId),
    duration: 0,
    ownerName: "MiniMax",
  };
}
