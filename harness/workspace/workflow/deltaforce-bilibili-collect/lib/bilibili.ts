/**
 * Bilibili video downloader.
 *
 * Mirrors the validated Python reference downloader: use `bilibili-api-ts` to
 * fetch video info, fetch the download URL with the real bvid/cid pair, then
 * either remux an FLV single-stream or merge a DASH video+audio pair into a
 * single mp4 via ffmpeg.
 *
 *  the workflow only needs the merged mp4 because MiniMax M3 reads the
 * video directly — no per-second frame extraction any more.
 */

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveFfmpegPath, runFfmpeg } from "./ffmpeg";
import { sanitizeFileSegment } from "./values";

export const QN_OPTIONS = [16, 32, 64, 80, 112, 116, 120] as const;
export type QnQuality = (typeof QN_OPTIONS)[number];
export type BilibiliVideoCodecPreference = "auto" | "av1" | "hevc" | "h264";

export interface BilibiliCredential {
  sessdata?: string;
  biliJct?: string;
  buvid3?: string;
}

export interface BilibiliVideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  pageIndex: number;
  pageTitle?: string;
  title: string;
  link: string;
  duration: number;
  ownerName?: string;
  coverUrl?: string;
}

export interface BilibiliDownloadResult {
  info: BilibiliVideoInfo;
  /** Absolute path to the merged mp4 on local disk. */
  localVideoPath: string;
  /** Best-effort file size in bytes. */
  size: number;
  /** When positive, the video was trimmed to this many seconds. */
  trimmedSeconds?: number;
}

export interface BilibiliDownloadOptions {
  bvid: string;
  videoUrl: string;
  pageIndex: number;
  outputDir: string;
  keepVideo: boolean;
  quality: QnQuality;
  videoCodec: BilibiliVideoCodecPreference;
  credential: BilibiliCredential;
  signal?: AbortSignal;
  /** When positive, trim the video to this many seconds during ffmpeg muxing. */
  maxDurationSeconds?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Compute the ffmpeg -t duration to trim to, in seconds.
 * Returns undefined when no trimming is needed (video is short enough or no
 * limit was configured). Returns a positive integer when the video duration
 * exceeds `maxDurationSeconds`.
 */
export function computeTrimDuration(videoDuration: number, maxDurationSeconds: number | undefined): number | undefined {
  if (maxDurationSeconds === undefined || maxDurationSeconds <= 0) {
    return undefined;
  }
  if (!Number.isFinite(videoDuration) || videoDuration <= maxDurationSeconds) {
    return undefined;
  }
  return maxDurationSeconds;
}

interface BilibiliApiTsModule {
  Credential: new (input: { sessdata?: string; bili_jct?: string; buvid3?: string }) => unknown;
}

interface BilibiliVideoModule {
  Video: new (input: { bvid: string; credential?: unknown }) => {
    get_info(): Promise<unknown>;
    get_pages(): Promise<unknown>;
  };
}

const BILIBILI_PLAYURL_URL = "https://api.bilibili.com/x/player/playurl";

export async function downloadBilibiliVideo(options: BilibiliDownloadOptions): Promise<BilibiliDownloadResult> {
  const biliApi = await importBilibiliApi();
  const biliVideo = await importBilibiliVideo();
  const credential = biliApi.Credential
    ? new biliApi.Credential({
        sessdata: options.credential.sessdata,
        bili_jct: options.credential.biliJct,
        buvid3: options.credential.buvid3,
      })
    : undefined;
  const video = new biliVideo.Video({ bvid: options.bvid, credential });

  // /app + other local runners can hit transient network errors
  // from bilibili-api-ts's internal fetch (e.g. ECONNRESET, ETIMEDOUT, brief
  // 412 rate-limit responses). Wrap each call so a single failure surfaces
  // the bvid, the operation name, and the underlying cause instead of the
  // generic "fetch failed" Node message.
  const [rawInfo, rawPages] = await Promise.all([
    wrapBilibiliCall(`get_info(${options.bvid})`, () => video.get_info(), options.signal),
    wrapBilibiliCall(`get_pages(${options.bvid})`, () => video.get_pages(), options.signal),
  ]);

  const info = normalizeVideoInfo({
    rawInfo,
    rawPages,
    bvid: options.bvid,
    link: options.videoUrl,
    pageIndex: options.pageIndex,
  });

  // bilibili-api-ts still derives avid locally from bvid before it
  // calls playurl. Newer B 站 BV ids can map to much larger aids, and that
  // stale local conversion makes playurl return -404 even when the bvid works.
  // Keep the SDK for metadata, then call playurl with the real bvid/cid pair.
  const rawDownload = await wrapBilibiliCall(
    `get_download_url(${options.bvid}#p${options.pageIndex + 1}, cid=${info.cid})`,
    () => fetchBilibiliDownloadUrl({
      bvid: options.bvid,
      aid: info.aid,
      cid: info.cid,
      quality: options.quality,
      credential: options.credential,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    }),
    options.signal,
  );

  const streams = pickStreams(rawDownload, options.quality, options.videoCodec, options.credential);
  if (streams.length === 0) {
    throw new Error(
      `No downloadable streams <= qn=${options.quality} for ${options.bvid}. ` +
        `Try a higher --quality or supply BILIBILI_SESSDATA.`,
    );
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "workflow-bilibili-dl-"));
  const safeTitle = sanitizeFileSegment(info.title) || options.bvid;
  const finalPath = path.join(options.outputDir, `${safeTitle}.mp4`);

  // /app (Electron) and other local runners pass an outputDir under
  // os.tmpdir() that the process has not yet created. ffmpeg refuses to
  // open a writer on a missing directory, so make sure it exists first.
  await mkdir(options.outputDir, { recursive: true });

  // MiniMax M3 video understanding rejects videos longer than roughly
  // 5–10 minutes with HTTP 422 ("video is sensitive", error code 1026). The
  // downstream understand endpoint cannot distinguish between a genuinely
  // sensitive video and one that exceeds the internal processing budget, so
  // trim proactively when the user sets --max-duration.
  const trimSeconds = computeTrimDuration(info.duration, options.maxDurationSeconds);

  try {
    if (isFlvStream(rawDownload)) {
      const flvPath = path.join(tempDir, `${safeTitle}.flv`);
      await downloadHttpStream(streams[0].url, streams[0].headers, flvPath, options.fetchImpl, options.signal);
      await ffmpegRemux(flvPath, finalPath, options.signal, trimSeconds);
    } else {
      const videoPath = path.join(tempDir, `${safeTitle}_video.m4s`);
      const audioPath = path.join(tempDir, `${safeTitle}_audio.m4s`);
      await downloadHttpStream(streams[0].url, streams[0].headers, videoPath, options.fetchImpl, options.signal);
      if (streams.length >= 2) {
        await downloadHttpStream(streams[1].url, streams[1].headers, audioPath, options.fetchImpl, options.signal);
        await ffmpegMerge(videoPath, audioPath, finalPath, options.signal, trimSeconds);
      } else {
        // Video-only stream (rare); copy to mp4.
        await ffmpegRemux(videoPath, finalPath, options.signal, trimSeconds);
      }
    }

    const stat = await readFile(finalPath);
    return {
      info,
      localVideoPath: finalPath,
      size: stat.byteLength,
      trimmedSeconds: trimSeconds,
    };
  } finally {
    if (!options.keepVideo) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function parseQuality(value: number | string | undefined): QnQuality {
  if (typeof value === "number" && QN_OPTIONS.includes(value as QnQuality)) {
    return value as QnQuality;
  }
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    if (QN_OPTIONS.includes(parsed as QnQuality)) {
      return parsed as QnQuality;
    }
  }
  return 32;
}

export function parseVideoCodecPreference(value: unknown): BilibiliVideoCodecPreference {
  if (typeof value !== "string") {
    return "auto";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "av1" || normalized === "hevc" || normalized === "h264") {
    return normalized;
  }
  return "auto";
}

export function createBilibiliPlayUrl(input: {
  bvid: string;
  aid?: number;
  cid: number;
  quality: QnQuality;
}): string {
  const params = new URLSearchParams({
    bvid: input.bvid,
    cid: String(input.cid),
    qn: String(input.quality),
    otype: "json",
    fnval: "4048",
    fourk: "1",
  });
  if (input.aid !== undefined && Number.isFinite(input.aid) && input.aid > 0) {
    params.set("avid", String(input.aid));
  }
  return `${BILIBILI_PLAYURL_URL}?${params.toString()}`;
}

export async function fetchBilibiliDownloadUrl(input: {
  bvid: string;
  aid?: number;
  cid: number;
  quality: QnQuality;
  credential: BilibiliCredential;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<unknown> {
  const requestUrl = createBilibiliPlayUrl(input);
  const f = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await f(requestUrl, {
    headers: buildBilibiliHeaders(input.credential),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from Bilibili playurl.`);
  }

  const payload = await response.json() as unknown;
  if (!isObject(payload)) {
    throw new Error("Bilibili playurl returned a non-object response.");
  }
  const code = readNumber(payload.code);
  if (code !== 0) {
    const message = readString(payload.message) ?? "接口未返回错误信息";
    throw new Error(`${code ?? "unknown"}: ${message}`);
  }
  const data = (payload as { data?: unknown; result?: unknown }).data ?? (payload as { result?: unknown }).result;
  if (data === undefined) {
    throw new Error("Bilibili playurl response did not contain data.");
  }
  return data;
}

interface StreamDescriptor {
  url: string;
  headers: Record<string, string>;
}

function pickStreams(
  rawDownload: unknown,
  maxQuality: QnQuality,
  videoCodec: BilibiliVideoCodecPreference,
  credential?: BilibiliCredential,
): StreamDescriptor[] {
  if (!isObject(rawDownload)) {
    return [];
  }
  // FLV single stream
  const durl = (rawDownload as { durl?: unknown }).durl;
  if (Array.isArray(durl) && durl.length > 0) {
    return durl
      .map((entry) => toStreamDescriptor(entry, credential))
      .filter((entry): entry is StreamDescriptor => entry !== null);
  }
  // DASH video + audio
  const dash = (rawDownload as { dash?: unknown }).dash;
  if (isObject(dash)) {
    const videos = Array.isArray((dash as { video?: unknown }).video) ? (dash as { video: unknown[] }).video : [];
    const audios = Array.isArray((dash as { audio?: unknown }).audio) ? (dash as { audio: unknown[] }).audio : [];
    const bestVideo = pickBestVideoStream(videos.filter(isObject), {
      maxQuality,
      videoCodec,
    });
    const bestAudio = pickBestStream(audios.filter(isObject));
    const result: StreamDescriptor[] = [];
    if (bestVideo !== null) {
      result.push({
        url: readString(bestVideo.baseUrl) ?? readString((bestVideo as { base_url?: unknown }).base_url) ?? "",
        headers: buildBilibiliHeaders(credential),
      });
    }
    if (bestAudio !== null) {
      result.push({
        url: readString(bestAudio.baseUrl) ?? readString((bestAudio as { base_url?: unknown }).base_url) ?? "",
        headers: buildBilibiliHeaders(credential),
      });
    }
    return result;
  }
  return [];
}

export function pickBestVideoStream(
  items: Array<Record<string, unknown>>,
  options: { maxQuality?: QnQuality; videoCodec?: BilibiliVideoCodecPreference } = {},
): Record<string, unknown> | null {
  const candidates = options.maxQuality === undefined
    ? items
    : items.filter((item) => {
      const id = readNumber(item.id);
      return id === undefined || id <= options.maxQuality!;
    });
  const codecPreference = options.videoCodec ?? "auto";
  const codecCandidates = codecPreference === "auto"
    ? candidates
    : candidates.filter((item) => readVideoCodec(item) === codecPreference);
  const filteredCandidates = codecCandidates.length > 0 ? codecCandidates : candidates;
  if (filteredCandidates.length === 0) {
    return null;
  }

  // MiniMax accepted the B 站 AV1 stream for BV1ewVS6wE76 but
  // rejected the same video's AVC/H.264 stream as sensitive. Default to the
  // lower-bitrate modern codecs that match the validated Python reference
  // downloader, while still allowing explicit h264 for compatibility.
  const sorted = [...filteredCandidates].sort(
    (a, b) => scoreVideoStream(b, codecPreference) - scoreVideoStream(a, codecPreference),
  );
  return sorted[0];
}

function pickBestStream(items: Array<Record<string, unknown>>, maxQuality?: QnQuality): Record<string, unknown> | null {
  const candidates = maxQuality === undefined
    ? items
    : items.filter((item) => {
      const id = readNumber(item.id);
      return id === undefined || id <= maxQuality;
    });
  if (candidates.length === 0) {
    return null;
  }
  const sorted = [...candidates].sort((a, b) => scoreGenericStream(b) - scoreGenericStream(a));
  return sorted[0];
}

function scoreVideoStream(stream: Record<string, unknown>, preference: BilibiliVideoCodecPreference): number {
  const codecid = readNumber(stream.codecid);
  const id = readNumber(stream.id) ?? 0;
  const bandwidth = readNumber(stream.bandwidth) ?? 0;
  let score = id * 1000 + bandwidth / 1_000_000;
  const codec = readVideoCodec(stream);
  if (preference === "auto") {
    if (codec === "av1") score += 30_000;
    if (codec === "hevc") score += 20_000;
    if (codec === "h264") score += 10_000;
    score -= bandwidth / 100_000;
  }
  return score;
}

function scoreGenericStream(stream: Record<string, unknown>): number {
  const id = readNumber(stream.id) ?? 0;
  const bandwidth = readNumber(stream.bandwidth) ?? 0;
  return id * 1000 + bandwidth / 1_000_000;
}

function readVideoCodec(stream: Record<string, unknown>): BilibiliVideoCodecPreference | undefined {
  const codecid = readNumber(stream.codecid);
  if (codecid === 13) return "av1";
  if (codecid === 12) return "hevc";
  if (codecid === 7) return "h264";
  const codecs = readString(stream.codecs)?.toLowerCase() ?? "";
  if (codecs.startsWith("av01")) return "av1";
  if (codecs.startsWith("hev1") || codecs.startsWith("hvc1")) return "hevc";
  if (codecs.startsWith("avc1")) return "h264";
  return undefined;
}

function toStreamDescriptor(value: unknown, credential?: BilibiliCredential): StreamDescriptor | null {
  if (!isObject(value)) {
    return null;
  }
  const url = readString(value.url);
  if (url === undefined) {
    return null;
  }
  return { url, headers: buildBilibiliHeaders(credential) };
}

function isFlvStream(rawDownload: unknown): boolean {
  if (!isObject(rawDownload)) {
    return false;
  }
  return Array.isArray((rawDownload as { durl?: unknown }).durl);
}

export function normalizeVideoInfo(input: {
  rawInfo: unknown;
  rawPages: unknown;
  bvid: string;
  link: string;
  pageIndex: number;
}): BilibiliVideoInfo {
  const info = isObject(input.rawInfo) ? input.rawInfo : {};
  const pages = Array.isArray(info.pages)
    ? info.pages
    : Array.isArray(input.rawPages)
      ? input.rawPages
      : [];
  const rawPage = pages[input.pageIndex];
  if (pages.length > 0 && !isObject(rawPage)) {
    throw new Error(`Bilibili video ${input.bvid} has ${pages.length} part(s); pageIndex ${input.pageIndex + 1} is out of range.`);
  }
  const page = isObject(rawPage) ? rawPage : {};
  const cid = readNumber(page.cid) ?? readNumber(info.cid) ?? 0;
  const duration = readNumber(page.duration) ?? readNumber(info.duration) ?? 0;

  return {
    bvid: readString(info.bvid) ?? input.bvid,
    aid: readNumber(info.aid) ?? 0,
    cid,
    pageIndex: input.pageIndex,
    pageTitle: readString(page.part),
    title: readString(info.title) ?? input.bvid,
    link: input.link,
    duration,
    ownerName: isObject(info.owner) ? readString((info.owner as Record<string, unknown>).name) : undefined,
    coverUrl: readString(info.pic),
  };
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

function buildBilibiliHeaders(credential?: BilibiliCredential): Record<string, string> {
  const headers: Record<string, string> = {
    Referer: "https://www.bilibili.com",
    "User-Agent": USER_AGENT,
    Origin: "https://www.bilibili.com",
  };
  const cookie = buildBilibiliCookieHeader(credential);
  if (cookie !== undefined) {
    headers.Cookie = cookie;
  }
  return headers;
}

function buildBilibiliCookieHeader(credential: BilibiliCredential | undefined): string | undefined {
  if (credential === undefined) {
    return undefined;
  }
  const cookies = [
    credential.sessdata === undefined || credential.sessdata === "" ? undefined : `SESSDATA=${credential.sessdata}`,
    credential.biliJct === undefined || credential.biliJct === "" ? undefined : `bili_jct=${credential.biliJct}`,
    credential.buvid3 === undefined || credential.buvid3 === "" ? undefined : `buvid3=${credential.buvid3}`,
  ].filter((cookie): cookie is string => cookie !== undefined);
  return cookies.length === 0 ? undefined : cookies.join("; ");
}

async function downloadHttpStream(
  url: string,
  headers: Record<string, string>,
  outputPath: string,
  fetchImpl: typeof fetch | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const f = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await f(url, { headers, signal });
  if (!response.ok || response.body === null) {
    throw new Error(`Bilibili segment download failed with HTTP ${response.status}.`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath), { signal });
}

async function ffmpegRemux(input: string, output: string, signal: AbortSignal | undefined, durationLimitSeconds?: number): Promise<void> {
  const ffmpeg = await resolveFfmpegPath();
  const args = [
    "-y",
    "-i",
    input,
    "-c",
    "copy",
  ];
  if (durationLimitSeconds !== undefined && durationLimitSeconds > 0) {
    args.push("-t", String(durationLimitSeconds));
  }
  args.push("-movflags", "+faststart", output);
  await runFfmpeg(ffmpeg, args, signal);
}

async function ffmpegMerge(
  videoPath: string,
  audioPath: string,
  output: string,
  signal: AbortSignal | undefined,
  durationLimitSeconds?: number,
): Promise<void> {
  const ffmpeg = await resolveFfmpegPath();
  const args = [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-c",
    "copy",
  ];
  if (durationLimitSeconds !== undefined && durationLimitSeconds > 0) {
    args.push("-t", String(durationLimitSeconds));
  }
  args.push("-movflags", "+faststart", output);
  await runFfmpeg(ffmpeg, args, signal);
}

async function importBilibiliApi(): Promise<BilibiliApiTsModule> {
  try {
    return (await import("bilibili-api-ts")) as unknown as BilibiliApiTsModule;
  } catch (error) {
    throw new Error(
      `Failed to import bilibili-api-ts. Did you pnpm install in workspace/workflow/deltaforce-bilibili-collect/? (${(error as Error).message})`,
    );
  }
}

const BILIBILI_API_MAX_RETRIES = 3;
const BILIBILI_API_RETRY_BACKOFF_MS = 1_500;

async function wrapBilibiliCall<T>(
  label: string,
  run: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < BILIBILI_API_MAX_RETRIES; attempt += 1) {
    try {
      if (signal?.aborted === true) {
        throw new Error("Bilibili API call was aborted.");
      }
      return await run();
    } catch (error) {
      lastError = error;
      if (signal?.aborted === true) {
        throw new BilibiliApiError(label, error, attempt + 1, false);
      }
      if (attempt < BILIBILI_API_MAX_RETRIES - 1 && isTransientBilibiliError(error)) {
        await delay(BILIBILI_API_RETRY_BACKOFF_MS * Math.pow(2, attempt), signal);
        continue;
      }
      throw new BilibiliApiError(label, error, attempt + 1, isTransientBilibiliError(error));
    }
  }
  throw new BilibiliApiError(label, lastError, BILIBILI_API_MAX_RETRIES, false);
}

class BilibiliApiError extends Error {
  readonly operation: string;
  readonly cause: unknown;
  readonly attempts: number;
  readonly retriable: boolean;

  constructor(operation: string, cause: unknown, attempts: number, retriable: boolean) {
    const message = describeBilibiliError(operation, cause, attempts, retriable);
    super(message);
    this.name = "BilibiliApiError";
    this.operation = operation;
    this.cause = cause;
    this.attempts = attempts;
    this.retriable = retriable;
  }
}

function describeBilibiliError(
  operation: string,
  cause: unknown,
  attempts: number,
  retriable: boolean,
): string {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const rootCause = unwrapError(cause);
  const sysCode = readNodeSystemCode(rootCause);
  const attemptLabel = attempts > 1 ? ` after ${attempts} attempts` : "";
  const sysLabel = sysCode !== undefined ? ` (${sysCode})` : "";
  return `Bilibili API call ${operation} failed${attemptLabel}: ${causeMessage}${sysLabel}` +
    (retriable ? ". Check B 站 network, SESSDATA cookie, or try again." : "");
}

function unwrapError(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      current !== null &&
      typeof current === "object" &&
      "cause" in current &&
      (current as { cause: unknown }).cause !== undefined
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

function isTransientBilibiliError(error: unknown): boolean {
  const root = unwrapError(error);
  if (root === null || typeof root !== "object") {
    return false;
  }
  const code = (root as { code?: unknown }).code;
  if (typeof code === "string") {
    return TRANSIENT_NETWORK_CODES.has(code);
  }
  const name = (root as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Bilibili retry was aborted."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Bilibili retry was aborted."));
    }, { once: true });
  });
}

async function importBilibiliVideo(): Promise<BilibiliVideoModule> {
  try {
    return (await import("bilibili-api-ts/video.js")) as unknown as BilibiliVideoModule;
  } catch (error) {
    throw new Error(
      `Failed to import bilibili-api-ts/video.js. (${(error as Error).message})`,
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
