export type GptImageMode = "generate" | "edit";
export type GptImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536" | `${number}x${number}`;
export type GptImageQuality = "auto" | "low" | "medium" | "high";
export type GptImageFormat = "png" | "jpeg" | "webp";
export type GptImageBackground = "auto" | "opaque" | "transparent";
export type GptImageResolvedBackground = Exclude<GptImageBackground, "transparent">;
export type GptImageInputFidelity = "low" | "high";
export type GptImageModeration = "auto" | "low";

export interface GptImageInput {
  prompt: string;
  images: FileReference[];
  size?: string;
  quality?: string;
  outputFormat?: string;
  outputCompression?: number;
  background?: string;
  inputFidelity?: string;
  moderation?: string;
  imageRunner?: GptImageRunner;
}

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

export interface FileReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  storage: "local" | "server" | "path" | "url";
  projectId?: string;
  conversationId?: string;
  createdAt: string;
  url?: string;
  path?: string;
}

export interface ResolvedFile extends FileReference {
  readBuffer(): Promise<Buffer>;
  readBase64(): Promise<string>;
  readDataUrl(): Promise<string>;
  toJSON(): FileReference;
}

export interface GptImageParsedInput extends RunPayload {
  prompt: string;
  images: FileReference[];
  size: GptImageSize;
  quality: GptImageQuality;
  outputFormat: GptImageFormat;
  outputCompression?: number;
  background: GptImageResolvedBackground;
  inputFidelity: GptImageInputFidelity;
  moderation: GptImageModeration;
  imageRunner?: GptImageRunner;
}

export interface GptImageRequest extends GptImageParsedInput {
  resolvedImages: ResolvedFile[];
  currentImages: ResolvedFile[];
  contextImages: ResolvedFile[];
  mode: GptImageMode;
  modelPrompt: string;
  contextMessageCount: number;
  conversationTitle?: string;
}

export interface GptImageRunnerInput {
  mode: GptImageMode;
  model: "gpt-image-2";
  prompt: string;
  images: ResolvedFile[];
  size: GptImageSize;
  quality: GptImageQuality;
  outputFormat: GptImageFormat;
  outputCompression?: number;
  background: GptImageResolvedBackground;
  inputFidelity: GptImageInputFidelity;
  moderation: GptImageModeration;
  apiKey?: string;
  baseURL?: string;
}

export interface GptImageRunnerResult {
  b64Json: string;
  mimeType: string;
  revisedPrompt?: string;
}

export type GptImageRunner = (
  input: GptImageRunnerInput,
) => Promise<GptImageRunnerResult> | GptImageRunnerResult;

export interface GptImageOutputPayload extends RunOutputPayload {
  conversationId?: string;
  historyLength: number;
  conversationMessages: number;
  contextMessageCount: number;
  mode: GptImageMode;
  model: "gpt-image-2";
  prompt: string;
  modelPrompt: string;
  revisedPrompt?: string;
  imageCount: number;
  inputImageCount: number;
  contextImageCount: number;
  size: GptImageSize;
  quality: GptImageQuality;
  outputFormat: GptImageFormat;
  outputCompression?: number;
  background: GptImageResolvedBackground;
  inputFidelity: GptImageInputFidelity;
  moderation: GptImageModeration;
  mimeType: string;
  dataUrl: string;
}

export type GptImageOutput = ExecutorResult<GptImageOutputPayload>;
