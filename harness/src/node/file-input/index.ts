import { BaseNode } from "../base";
import type {
  NodeContext,
  NodeMetadataInput,
} from "../../types/index";
import {
  parseProjectFileReferences,
  type FileReference,
  type ResolvedFile,
} from "../../files/index";
import { HarnessError } from "../../workflow/errors";

export interface FileInputNodeOptions {
  name?: string;
  accept?: string[];
  multiple?: boolean;
  historyLimit?: number;
  metadata?: NodeMetadataInput;
}

export function createFileInputNode(
  options: FileInputNodeOptions = {},
): BaseNode<unknown, ResolvedFile[]> {
  return new FileInputNode(options);
}

class FileInputNode extends BaseNode<unknown, ResolvedFile[]> {
  private readonly accept: string[];
  private readonly multiple: boolean;

  constructor(options: FileInputNodeOptions) {
    super({
      name: options.name ?? "file-input",
      standardName: "file-input",
      historyLimit: options.historyLimit,
      metadata: options.metadata,
    });
    this.accept = options.accept ?? [];
    this.multiple = options.multiple ?? true;
  }

  protected async execute(
    input: unknown,
    context: NodeContext,
  ): Promise<ResolvedFile[]> {
    if (context.files === undefined) {
      throw new HarnessError({
        type: "input_validation",
        message: "Workflow file input is used, but no workflow file store was configured.",
      });
    }

    const references = parseProjectFileReferences(input);
    if (!this.multiple && references.length > 1) {
      throw new HarnessError({
        type: "input_validation",
        message: `File input node "${this.name}" accepts only one file.`,
        metadata: {
          count: references.length,
        },
      });
    }

    for (const reference of references) {
      this.assertAccepted(reference);
    }

    return Promise.all(references.map((reference) => context.files!.resolveFile(reference)));
  }

  private assertAccepted(reference: FileReference): void {
    if (this.accept.length === 0) {
      return;
    }

    const accepted = this.accept.some((pattern) =>
      matchesAcceptPattern(reference, pattern),
    );

    if (!accepted) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow file "${reference.name}" type "${reference.mimeType}" is not accepted by "${this.name}".`,
        metadata: {
          fileId: reference.id,
          mimeType: reference.mimeType,
          accept: this.accept,
        },
      });
    }
  }
}

function matchesAcceptPattern(
  reference: FileReference,
  pattern: string,
): boolean {
  const normalized = pattern.trim().toLowerCase();
  const mimeType = reference.mimeType.toLowerCase();
  const name = reference.name.toLowerCase();

  if (normalized === "") {
    return false;
  }

  if (normalized.endsWith("/*")) {
    return mimeType.startsWith(normalized.slice(0, -1));
  }

  if (normalized.startsWith(".")) {
    return name.endsWith(normalized);
  }

  return mimeType === normalized;
}
