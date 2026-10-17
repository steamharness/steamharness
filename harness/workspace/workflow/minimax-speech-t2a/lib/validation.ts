import type {
  MinimaxSpeechEmotion,
  MinimaxSpeechFormat,
  MinimaxSpeechInput,
} from "../interface";

export const DEFAULT_MINIMAX_T2A_MODEL = "speech-2.8-turbo";
export const DEFAULT_MINIMAX_VOICE_ID = "male-qn-qingse";
export const DEFAULT_MINIMAX_FORMAT: MinimaxSpeechFormat = "mp3";
export const DEFAULT_MINIMAX_SAMPLE_RATE = 32000;
export const DEFAULT_MINIMAX_BITRATE = 128000;
export const DEFAULT_MINIMAX_CHANNEL = 1;
export const DEFAULT_MINIMAX_SPEED = 1;
export const DEFAULT_MINIMAX_VOL = 1;
export const DEFAULT_MINIMAX_PITCH = 0;
export const DEFAULT_MINIMAX_TIMEOUT_MS = 120000;

const MAX_TEXT_LENGTH = 5000;
const FORMATS: readonly MinimaxSpeechFormat[] = ["mp3", "wav", "pcm", "flac"];
const EMOTIONS: readonly MinimaxSpeechEmotion[] = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
];
const SAMPLE_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100]);
const BITRATES = new Set([32000, 64000, 128000, 256000]);
const CHANNELS = new Set([1, 2]);

export interface RawMinimaxSpeechInput {
  text?: unknown;
  model?: unknown;
  voiceId?: unknown;
  format?: unknown;
  sampleRate?: unknown;
  bitrate?: unknown;
  channel?: unknown;
  speed?: unknown;
  vol?: unknown;
  pitch?: unknown;
  emotion?: unknown;
  languageBoost?: unknown;
  dryRun?: unknown;
  timeoutMs?: unknown;
}

export function parseMinimaxSpeechInput(input: RawMinimaxSpeechInput): MinimaxSpeechInput {
  const text = readString(input.text).trim();
  if (text.length === 0) {
    throw new Error("Text is required.");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Text must be ${MAX_TEXT_LENGTH} characters or fewer.`);
  }

  const model = readString(input.model).trim() || DEFAULT_MINIMAX_T2A_MODEL;
  const voiceId = readString(input.voiceId).trim() || DEFAULT_MINIMAX_VOICE_ID;
  const format = readEnum(input.format, FORMATS, DEFAULT_MINIMAX_FORMAT, "format");
  const sampleRate = readInteger(input.sampleRate, DEFAULT_MINIMAX_SAMPLE_RATE, "sampleRate");
  const bitrate = readInteger(input.bitrate, DEFAULT_MINIMAX_BITRATE, "bitrate");
  const channel = readInteger(input.channel, DEFAULT_MINIMAX_CHANNEL, "channel");
  const speed = readNumber(input.speed, DEFAULT_MINIMAX_SPEED, "speed");
  const vol = readNumber(input.vol, DEFAULT_MINIMAX_VOL, "vol");
  const pitch = readInteger(input.pitch, DEFAULT_MINIMAX_PITCH, "pitch");
  const timeoutMs = readInteger(input.timeoutMs, DEFAULT_MINIMAX_TIMEOUT_MS, "timeoutMs");

  if (!SAMPLE_RATES.has(sampleRate)) {
    throw new Error("sampleRate must be one of 8000, 16000, 22050, 24000, 32000, or 44100.");
  }
  if (!BITRATES.has(bitrate)) {
    throw new Error("bitrate must be one of 32000, 64000, 128000, or 256000.");
  }
  if (!CHANNELS.has(channel)) {
    throw new Error("channel must be 1 or 2.");
  }
  assertRange(speed, 0.5, 2, "speed");
  assertRange(vol, 0, 10, "vol");
  assertRange(pitch, -12, 12, "pitch");
  assertRange(timeoutMs, 1000, 10 * 60 * 1000, "timeoutMs");

  const emotion = readOptionalEnum(input.emotion, EMOTIONS, "emotion");
  const languageBoost = readString(input.languageBoost).trim();

  return {
    errCode: 0,
    errMessage: "",
    text,
    model,
    voiceId,
    format,
    sampleRate,
    bitrate,
    channel,
    speed,
    vol,
    pitch,
    emotion,
    languageBoost: languageBoost === "" ? undefined : languageBoost,
    dryRun: readBoolean(input.dryRun),
    timeoutMs,
  };
}

export function readArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

export function readArgBoolean(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  const candidate = readString(value).trim();
  if (candidate === "") return fallback;
  if ((allowed as readonly string[]).includes(candidate)) return candidate as T;
  throw new Error(`${label} must be one of ${allowed.join(", ")}.`);
}

function readOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  const candidate = readString(value).trim();
  if (candidate === "") return undefined;
  if ((allowed as readonly string[]).includes(candidate)) return candidate as T;
  throw new Error(`${label} must be one of ${allowed.join(", ")}.`);
}

function readInteger(value: unknown, fallback: number, label: string): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

function readNumber(value: unknown, fallback: number, label: string): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return parsed;
}

function assertRange(value: number, min: number, max: number, label: string): void {
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
}
