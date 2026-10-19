import { parseProjectFileReferences, type FileReference } from "../files/index";

export interface ConversationDefaultInputValue {
  message: string;
  images: FileReference[];
  videos: FileReference[];
  files: FileReference[];
}

/**
 * Conversation workflows always use the standard composer.
 * Hosts serialize that composer to fixed workflow args so createInput remains
 * explicit and portable across local hosts.
 */
export function parseConversationDefaultInputArgs(
  args: string[],
): ConversationDefaultInputValue {
  const messageValues = readFlagValues(args, "--message");
  const imageValues = readFlagValues(args, "--images");
  const videoValues = readFlagValues(args, "--videos");
  const fileValues = readFlagValues(args, "--files");

  return {
    message: messageValues.at(-1)?.trim() ?? "",
    images: imageValues.flatMap((value) => parseProjectFileReferences(value)),
    videos: videoValues.flatMap((value) => parseProjectFileReferences(value)),
    files: fileValues.flatMap((value) => parseProjectFileReferences(value)),
  };
}

function readFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }

    const value = args[index + 1];
    if (value !== undefined) {
      values.push(value);
      index += 1;
    }
  }

  return values;
}
