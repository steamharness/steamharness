import { parseMinimaxSpeechInput } from "../lib/validation";
import type { MinimaxSpeechInput } from "../interface";

export const inputNode = workflow.createInputNode<MinimaxSpeechInput, MinimaxSpeechInput>({
  name: "minimax-speech-input",
  parse(input) {
    return parseMinimaxSpeechInput(input);
  },
});
