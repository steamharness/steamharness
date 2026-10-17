import type { MinimaxSpeechFormat } from "../interface";

const MIME_TYPES: Record<MinimaxSpeechFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/L16",
  flac: "audio/flac",
};

export function mimeTypeForFormat(format: MinimaxSpeechFormat): string {
  return MIME_TYPES[format] ?? "application/octet-stream";
}

export function createAudioDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function decodeHexAudio(hexChunks: string[]): Uint8Array {
  const buffers = hexChunks.map((chunk) => {
    const normalized = chunk.trim();
    if (normalized === "") return Buffer.alloc(0);
    if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) {
      throw new Error("MiniMax returned invalid hex audio data.");
    }
    return Buffer.from(normalized, "hex");
  });
  return new Uint8Array(Buffer.concat(buffers));
}

export function createDryRunAudio(format: MinimaxSpeechFormat, sampleRate: number): {
  bytes: Uint8Array;
  durationMs: number;
} {
  const durationMs = 240;
  if (format !== "wav") {
    return {
      bytes: new TextEncoder().encode(`steamharness minimax dry-run ${format}`),
      durationMs,
    };
  }

  const channels = 1;
  const bitsPerSample = 16;
  const frameCount = Math.floor(sampleRate * durationMs / 1000);
  const dataSize = frameCount * channels * bitsPerSample / 8;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  buffer.writeUInt16LE(channels * bitsPerSample / 8, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < frameCount; index += 1) {
    const phase = index / sampleRate;
    const amplitude = Math.sin(phase * Math.PI * 2 * 440) * 1200;
    buffer.writeInt16LE(Math.round(amplitude), 44 + index * 2);
  }

  return {
    bytes: new Uint8Array(buffer),
    durationMs,
  };
}
