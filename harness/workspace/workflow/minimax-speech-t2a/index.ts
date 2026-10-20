import type {
  MinimaxSpeechInput,
  MinimaxSpeechOutputPayload,
} from "./interface";
import { inputNode } from "./nodes/input";
import { synthesisNode } from "./nodes/synthesis";
import { outputNode } from "./nodes/output";
import {
  DEFAULT_MINIMAX_TIMEOUT_MS,
  parseMinimaxSpeechInput,
  readArgBoolean,
  readArgValue,
} from "./lib/validation";

export const minimaxSpeechT2aProject = steamharness.defineProject<MinimaxSpeechInput, MinimaxSpeechOutputPayload>({
  name: "minimax-speech-t2a",
  async run(input, context) {
    const parsed = await steamharness.runNode(inputNode, input, context);
    const synthesized = await steamharness.runNode(synthesisNode, parsed, {
      ...context,
      metadata: {
        ...context.metadata,
        minimaxApiKey: steamharness.getConfig<string>("MINIMAX_API_KEY"),
      },
    });
    return steamharness.runNode(outputNode, synthesized, context);
  },
});

export const executor = steamharness.defineExecutor<
  MinimaxSpeechInput,
  MinimaxSpeechOutputPayload
>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    steamharness.defineEntrypoint<MinimaxSpeechInput, MinimaxSpeechOutputPayload>({
      id: "main",
      title: "MiniMax Speech T2A",
      workflow: minimaxSpeechT2aProject,
      registry: [
        { name: "input", node: inputNode },
        { name: "synthesis", node: synthesisNode },
        { name: "output", node: outputNode },
      ],
      params: [
        {
          name: "text",
          flag: "--text",
          type: "string",
          required: true,
          control: "textarea",
          description: "Text to synthesize.",
        },
        {
          name: "model",
          flag: "--model",
          type: "string",
          defaultValue: "speech-2.8-turbo",
          description: "MiniMax T2A model.",
        },
        {
          name: "voiceId",
          flag: "--voice-id",
          type: "string",
          defaultValue: "male-qn-qingse",
          description: "MiniMax voice id.",
        },
        {
          name: "format",
          flag: "--format",
          type: "string",
          control: "select",
          defaultValue: "mp3",
          options: [
            { value: "mp3", label: "MP3" },
            { value: "wav", label: "WAV" },
            { value: "pcm", label: "PCM" },
            { value: "flac", label: "FLAC" },
          ],
        },
        {
          name: "sampleRate",
          flag: "--sample-rate",
          type: "number",
          defaultValue: "32000",
          description: "Audio sample rate.",
        },
        {
          name: "bitrate",
          flag: "--bitrate",
          type: "number",
          defaultValue: "128000",
          description: "Audio bitrate.",
        },
        {
          name: "channel",
          flag: "--channel",
          type: "number",
          defaultValue: "1",
          description: "1 for mono, 2 for stereo.",
        },
        {
          name: "speed",
          flag: "--speed",
          type: "number",
          defaultValue: "1",
          description: "Speech speed, 0.5-2.",
        },
        {
          name: "vol",
          flag: "--vol",
          type: "number",
          defaultValue: "1",
          description: "Volume, 0-10.",
        },
        {
          name: "pitch",
          flag: "--pitch",
          type: "number",
          defaultValue: "0",
          description: "Pitch shift, -12 to 12.",
        },
        {
          name: "emotion",
          flag: "--emotion",
          type: "string",
          control: "select",
          defaultValue: "",
          options: [
            { value: "", label: "Default" },
            { value: "neutral", label: "Neutral" },
            { value: "happy", label: "Happy" },
            { value: "sad", label: "Sad" },
            { value: "angry", label: "Angry" },
            { value: "fearful", label: "Fearful" },
            { value: "disgusted", label: "Disgusted" },
            { value: "surprised", label: "Surprised" },
          ],
        },
        {
          name: "languageBoost",
          flag: "--language-boost",
          type: "string",
          defaultValue: "",
          description: "Optional MiniMax language boost.",
        },
        {
          name: "dryRun",
          flag: "--dry-run",
          type: "boolean",
          defaultValue: "false",
          description: "Use offline fixture audio instead of calling MiniMax.",
        },
      ],
      createInput({ args }) {
        return parseMinimaxSpeechInput({
          text:
            readArgValue(args, "--text") ??
            args.find((arg) => !arg.startsWith("--")),
          model: readArgValue(args, "--model"),
          voiceId: readArgValue(args, "--voice-id"),
          format: readArgValue(args, "--format"),
          sampleRate: readArgValue(args, "--sample-rate"),
          bitrate: readArgValue(args, "--bitrate"),
          channel: readArgValue(args, "--channel"),
          speed: readArgValue(args, "--speed"),
          vol: readArgValue(args, "--vol"),
          pitch: readArgValue(args, "--pitch"),
          emotion: readArgValue(args, "--emotion"),
          languageBoost: readArgValue(args, "--language-boost"),
          dryRun: readArgBoolean(args, "--dry-run"),
          timeoutMs: DEFAULT_MINIMAX_TIMEOUT_MS,
        });
      },
    }),
  ],
});

export { minimaxSpeechT2aProject as workflow };
export default minimaxSpeechT2aProject;
