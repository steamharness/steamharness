import { BaseNode } from "../base";
import type { NodeContext, NodeMetadataInput } from "../../types/index";

export type InputParser<Input, Output> = (
  input: Input,
  context: NodeContext,
) => Promise<Output> | Output;

export interface InputNodeOptions<Input, Output> {
  name?: string;
  parse?: InputParser<Input, Output>;
  historyLimit?: number;
  metadata?: NodeMetadataInput;
}

export function createInputNode<Input>(
  options?: InputNodeOptions<Input, Input>,
): BaseNode<Input, Input>;
export function createInputNode<Input, Output>(
  options: InputNodeOptions<Input, Output> & {
    parse: InputParser<Input, Output>;
  },
): BaseNode<Input, Output>;
export function createInputNode<Input, Output = Input>(
  options: InputNodeOptions<Input, Output> = {},
): BaseNode<Input, Output> {
  return new InputNode(options);
}

class InputNode<Input, Output> extends BaseNode<Input, Output> {
  private readonly parse?: InputParser<Input, Output>;

  constructor(options: InputNodeOptions<Input, Output>) {
    super({
      name: options.name ?? "input",
      standardName: "input",
      historyLimit: options.historyLimit,
      metadata: options.metadata,
    });
    this.parse = options.parse;
  }

  protected async execute(input: Input, context: NodeContext): Promise<Output> {
    if (this.parse) {
      return this.parse(input, context);
    }

    return input as unknown as Output;
  }
}
