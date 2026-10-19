export interface RunPayload {
  errCode: number;
  errMessage: string;
}

export type OutputContentType = "markdown" | "text" | "json" | "audio";

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

export type MinimaxSpeechFormat = "mp3" | "wav" | "pcm" | "flac";
export type MinimaxSpeechEmotion =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "fearful"
  | "disgusted"
  | "surprised";

export interface MinimaxSpeechInput extends RunPayload {
  text: string;
  model: string;
  voiceId: string;
  format: MinimaxSpeechFormat;
  sampleRate: number;
  bitrate: number;
  channel: number;
  speed: number;
  vol: number;
  pitch: number;
  emotion?: MinimaxSpeechEmotion;
  languageBoost?: string;
  dryRun: boolean;
  timeoutMs: number;
}

export interface MinimaxSpeechRequest extends MinimaxSpeechInput {
  apiKey?: string;
}

export interface MinimaxSpeechResult extends RunPayload {
  text: string;
  model: string;
  voiceId: string;
  format: MinimaxSpeechFormat;
  mimeType: string;
  bytes: Uint8Array;
  size: number;
  durationMs?: number;
  chunkCount: number;
  dryRun: boolean;
}

export interface AudioOutputDescriptor {
  src: string;
  mimeType: string;
  name: string;
  size: number;
  durationMs?: number;
  format: MinimaxSpeechFormat;
}

export interface MinimaxSpeechOutputPayload extends RunOutputPayload {
  text: string;
  model: string;
  voiceId: string;
  format: MinimaxSpeechFormat;
  mimeType: string;
  size: number;
  durationMs?: number;
  chunkCount: number;
  dryRun: boolean;
  audio: AudioOutputDescriptor;
}

export type MinimaxSpeechOutput = ExecutorResult<MinimaxSpeechOutputPayload>;
