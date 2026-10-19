import { createAudioDataUrl } from "../lib/audio";
import type {
  AudioOutputDescriptor,
  MinimaxSpeechOutputPayload,
  MinimaxSpeechResult,
} from "../interface";

export const outputNode = steamharness.createOutputNode<MinimaxSpeechResult, MinimaxSpeechOutputPayload>({
  name: "minimax-speech-output",
  format(result) {
    const audio = createAudioDescriptor(result);
    const payload = steamharness.createOutputPayload({
      items: [{
        title: result.dryRun ? "MiniMax speech audio preview" : "MiniMax speech audio",
        content: audio,
        contentType: "audio",
        iconPreset: "success",
        collapsed: false,
        metadata: {
          model: result.model,
          voiceId: result.voiceId,
          dryRun: result.dryRun,
          chunkCount: result.chunkCount,
        },
      }],
    }) as {
      errCode: number;
      errMessage: string;
      items: MinimaxSpeechOutputPayload["items"];
    };

    return {
      ...payload,
      text: result.text,
      model: result.model,
      voiceId: result.voiceId,
      format: result.format,
      mimeType: result.mimeType,
      size: result.size,
      durationMs: result.durationMs,
      chunkCount: result.chunkCount,
      dryRun: result.dryRun,
      audio,
    };
  },
});

function createAudioDescriptor(result: MinimaxSpeechResult): AudioOutputDescriptor {
  return {
    src: createAudioDataUrl(result.bytes, result.mimeType),
    mimeType: result.mimeType,
    name: `minimax-speech.${result.format}`,
    size: result.size,
    durationMs: result.durationMs,
    format: result.format,
  };
}
