import { parseWorkflowFileReferences, type WorkflowFileReference } from "../files/index";

export interface WorkflowConversationDefaultInputValue {
  message: string;
  images: WorkflowFileReference[];
  videos: WorkflowFileReference[];
  files: WorkflowFileReference[];
}

/**
 * Conversation workflows always use the standard composer.
 * Hosts serialize that composer to fixed workflow args so createInput remains
 * explicit and portable across local hosts.
 */
export function parseConversationDefaultInputArgs(
  args: string[],
): WorkflowConversationDefaultInputValue {
  const messageValues = readFlagValues(args, "--message");
  const imageValues = readFlagValues(args, "--images");
  const videoValues = readFlagValues(args, "--videos");
  const fileValues = readFlagValues(args, "--files");

  return {
    message: messageValues.at(-1)?.trim() ?? "",
    images: imageValues.flatMap((value) => parseWorkflowFileReferences(value)),
    videos: videoValues.flatMap((value) => parseWorkflowFileReferences(value)),
    files: fileValues.flatMap((value) => parseWorkflowFileReferences(value)),
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
