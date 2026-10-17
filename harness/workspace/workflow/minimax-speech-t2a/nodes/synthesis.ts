import { createDryRunAudio, mimeTypeForFormat } from "../lib/audio";
import { synthesizeMinimaxSpeech } from "../lib/minimax-websocket";
import type {
  MinimaxSpeechInput,
  MinimaxSpeechResult,
} from "../interface";

export const synthesisNode = workflow.createInputNode<MinimaxSpeechInput, MinimaxSpeechResult>({
  name: "minimax-speech-synthesis",
  async parse(input, context) {
    if (input.dryRun) {
      const audio = createDryRunAudio(input.format, input.sampleRate);
      return {
        errCode: 0,
        errMessage: "",
        text: input.text,
        model: input.model,
        voiceId: input.voiceId,
        format: input.format,
        mimeType: mimeTypeForFormat(input.format),
        bytes: audio.bytes,
        size: audio.bytes.byteLength,
        durationMs: audio.durationMs,
        chunkCount: 1,
        dryRun: true,
      };
    }

    const apiKey = readContextApiKey(context);
    if (apiKey === undefined) {
      throw new Error("MiniMax speech synthesis requires MINIMAX_API_KEY. Set it in .env or pass --dry-run.");
    }

    const audio = await synthesizeMinimaxSpeech({
      apiKey,
      input,
      signal: context.abortSignal,
      timeoutMs: input.timeoutMs,
    });

    return {
      errCode: 0,
      errMessage: "",
      text: input.text,
      model: input.model,
      voiceId: input.voiceId,
      format: input.format,
      mimeType: mimeTypeForFormat(input.format),
      bytes: audio.bytes,
      size: audio.bytes.byteLength,
      durationMs: audio.durationMs,
      chunkCount: audio.chunkCount,
      dryRun: false,
    };
  },
});

function readContextApiKey(context: { metadata?: Record<string, unknown> }): string | undefined {
  const apiKey = context.metadata?.minimaxApiKey;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return undefined;
  }
  return apiKey;
}
