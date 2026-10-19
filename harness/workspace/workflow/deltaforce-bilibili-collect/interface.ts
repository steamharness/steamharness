export interface RunPayload {
  errCode: number;
  errMessage: string;
}

export type OutputContentType = "markdown" | "text" | "json";

export interface OutputItem {
  id: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: OutputContentType;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RunOutputPayload extends RunPayload {
  items: OutputItem[];
}

export interface ExecutorResult<Output extends RunPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
}

export interface DeltaforceBilibiliCollectInput {
  videoUrl?: string;
  mm_file?: string;
  question?: string;
  model?: string;
  maxTokens?: number;
  quality?: number;
  videoCodec?: BilibiliVideoCodecPreference;
  maxDuration?: number;
  outputDir?: string;
  keepVideo?: boolean;
  pageIndex?: number;
  documentTitle?: string;
  documentId?: string;
  dryRun?: boolean;
  mockDownloader?: BilibiliDownloadRunner;
  mockUploader?: MinimaxUploadRunner;
  mockUnderstander?: MinimaxUnderstandRunner;
  fetchImpl?: typeof fetch;
}

export interface DeltaforceBilibiliCollectParsedInput extends RunPayload {
  videoUrl?: string;
  bvid?: string;
  mmFile: string | undefined;
  question: string;
  model: string;
  maxTokens: number;
  quality: number;
  videoCodec: BilibiliVideoCodecPreference;
  maxDuration: number;
  outputDir: string;
  keepVideo: boolean;
  pageIndex: number;
  documentTitle?: string;
  documentId?: string;
  dryRun: boolean;
  mockDownloader?: BilibiliDownloadRunner;
  mockUploader?: MinimaxUploadRunner;
  mockUnderstander?: MinimaxUnderstandRunner;
  fetchImpl?: typeof fetch;
}

export interface BilibiliCredentialConfig {
  sessdata?: string;
  biliJct?: string;
  buvid3?: string;
}

export interface ServerUploadConfig {
  workflowName: string;
  conversationId?: string;
}

export interface DeltaforceBilibiliCollectContext {
  metadata?: Record<string, unknown> & {
    bilibiliCredential?: BilibiliCredentialConfig;
    minimaxApiKey?: string;
    minimaxBaseUrl?: string;
    serverUpload?: ServerUploadConfig;
    bilibiliDownloadMock?: boolean;
    minimaxDryRun?: boolean;
  };
  conversation?: {
    conversationId?: string;
  };
  files?: FileStore;
  abortSignal?: AbortSignal;
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
  localVideoPath: string;
  size: number;
  /** When positive, the video was trimmed to this many seconds. */
  trimmedSeconds?: number;
}

export interface MinimaxUploadResult {
  fileId: string;
  raw: unknown;
}

export interface MinimaxUnderstandRequest {
  videoUrl: string;
  question: string;
  model: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface MinimaxUnderstandResult {
  transcript: string;
  chunks: number;
  model: string;
}

export interface FileStore {
  createFile?(input: {
    name: string;
    mimeType?: string;
    buffer: Buffer | Uint8Array | ArrayBuffer | string;
    kind?: "image" | "file";
    conversationId?: string;
  }): Promise<unknown> | unknown;
}

export interface DeltaforceBilibiliCollectDocument extends RunPayload {
  info: BilibiliVideoInfo;
  transcript: string;
  model: string;
  fileId: string;
  promptSeconds: number;
  markdown: string;
  documentId: string;
  documentTitle: string;
  knowledgeWritten: boolean;
  dryRun: boolean;
}

export interface DeltaforceBilibiliCollectOutputPayload extends RunOutputPayload {
  documentId: string;
  documentTitle: string;
  videoTitle: string;
  videoUrl: string;
  bvid: string;
  aid: number;
  cid: number;
  pageIndex: number;
  model: string;
  fileId: string;
  promptSeconds: number;
  transcriptLength: number;
  knowledgeWritten: boolean;
  dryRun: boolean;
}

export type DeltaforceBilibiliCollectOutput = ExecutorResult<DeltaforceBilibiliCollectOutputPayload>;

export type BilibiliVideoCodecPreference = "auto" | "av1" | "hevc" | "h264";

export type BilibiliDownloadRunner = (
  input: DeltaforceBilibiliCollectParsedInput,
  context: DeltaforceBilibiliCollectContext,
) => Promise<BilibiliDownloadResult> | BilibiliDownloadResult;

export type MinimaxUploadRunner = (
  localPath: string,
  options: { purpose?: string; signal?: AbortSignal },
  context: DeltaforceBilibiliCollectContext,
) => Promise<MinimaxUploadResult> | MinimaxUploadResult;

export type MinimaxUnderstandRunner = (
  request: MinimaxUnderstandRequest,
  context: DeltaforceBilibiliCollectContext,
) => Promise<MinimaxUnderstandResult> | MinimaxUnderstandResult;
