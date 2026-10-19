import type { LoopInput, LoopOutputPayload, LoopState } from "./interface";

const LOOP_RESULT_ITEM_ID = "loop-result";

const seedNode = workflow.createInputNode<LoopInput, LoopState>({
  name: "loop-seed",
  parse(input) {
    return {
      errCode: 0,
      errMessage: "",
      rounds: clampInteger(input.rounds, 1, 6),
      target: clampInteger(input.target, 6, 36),
      total: 0,
      steps: [],
    };
  },
});

const addRoundNode = workflow.createInputNode<LoopState & { value: number; index: number }, LoopState>({
  name: "add-round",
  parse(input) {
    const total = input.total + input.value;
    return {
      ...input,
      total,
      steps: [
        ...input.steps,
        `for #${input.index + 1}: +${input.value}, total=${total}`,
      ],
    };
  },
});

const burstBoostNode = workflow.createInputNode<LoopState & { value: number; index: number; iteration: number }, LoopState>({
  name: "burst-boost",
  parse(input) {
    const boost = clampBoost(input.value, input.target - input.total);
    const total = input.total + boost;
    return {
      ...input,
      total,
      lastBoostRoute: "burst",
      steps: [
        ...input.steps,
        `while #${input.iteration + 1} burst pass #${input.index + 1}: +${boost}, total=${total}`,
      ],
    };
  },
});

const steadyBoostNode = workflow.createInputNode<LoopState & { iteration: number }, LoopState>({
  name: "steady-boost",
  parse(input) {
    const boost = clampBoost(3, input.target - input.total);
    const total = input.total + boost;
    return {
      ...input,
      total,
      lastBoostRoute: "steady",
      steps: [
        ...input.steps,
        `while #${input.iteration + 1} steady boost: +${boost}, total=${total}`,
      ],
    };
  },
});

const finishBoostNode = workflow.createInputNode<LoopState & { iteration: number }, LoopState>({
  name: "finish-boost",
  parse(input) {
    const boost = clampBoost(2, input.target - input.total);
    const total = input.total + boost;
    return {
      ...input,
      total,
      lastBoostRoute: "finish",
      steps: [
        ...input.steps,
        `while #${input.iteration + 1} finish boost: +${boost}, total=${total}`,
      ],
    };
  },
});

const auditBoostNode = workflow.createInputNode<LoopState & { iteration: number }, LoopState>({
  name: "boost-audit",
  parse(input) {
    return {
      ...input,
      steps: [
        ...input.steps,
        `while #${input.iteration + 1} audit: route=${input.lastBoostRoute ?? "unknown"}, remaining=${Math.max(0, input.target - input.total)}`,
      ],
    };
  },
});

const outputNode = workflow.createOutputNode<LoopState, LoopOutputPayload>({
  name: "loop-output",
  async *stream(input) {
    // String chunks use host-generated ids. Stream the loop report as
    // one stable item so live output and final report do not duplicate.
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: LOOP_RESULT_ITEM_ID,
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_delta",
      itemId: LOOP_RESULT_ITEM_ID,
      delta: createLoopOutputContent(input),
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: LOOP_RESULT_ITEM_ID,
    });
  },
  format(stream, input) {
    return {
      ...workflow.createOutputPayload({
        items: stream.items,
      }),
      rounds: input.rounds,
      target: input.target,
      total: input.total,
      steps: input.steps,
      success: input.total >= input.target,
    };
  },
});

export const loopWorkflow = workflow.defineWorkflow<LoopInput, LoopOutputPayload>({
  name: "loop",
  async run(input, context) {
    const seed = await workflow.runNode(seedNode, input, context);

    const forResult = await workflow.runFor(seed, context, {
      name: "Round loop",
      maxIterations: 6,
      items: (state) => Array.from({ length: state.rounds }, (_, index) => index + 1),
      async run(state, value, index, loopContext) {
        return workflow.runNode(addRoundNode, { ...state, value, index }, loopContext);
      },
    });

    // Keep the loop sample visually rich enough to exercise nested
    // runWhile -> runIf -> runFor -> node rendering in the App Diagram.
    const whileResult = await workflow.runWhile(forResult, context, {
      name: "Boost until target",
      maxIterations: 8,
      condition: (state) => state.total < state.target,
      async run(state, loopContext, iteration) {
        const routed = await workflow.runIf<LoopState, LoopState>(state, loopContext, {
          name: "Choose boost strategy",
          branches: [
            {
              label: "burst",
              description: "Use multiple passes when the remaining gap is large.",
              condition: (current) => current.target - current.total >= 7,
              async run(current, branchContext) {
                return workflow.runFor(current, branchContext, {
                  name: "Burst passes",
                  maxIterations: 3,
                  items: () => [4, 3],
                  async run(passState, value, index, passContext) {
                    return workflow.runNode(burstBoostNode, { ...passState, value, index, iteration }, passContext);
                  },
                });
              },
            },
            {
              label: "steady",
              description: "Use a controlled boost for a medium remaining gap.",
              condition: (current) => current.target - current.total > 2,
              async run(current, branchContext) {
                return workflow.runNode(steadyBoostNode, { ...current, iteration }, branchContext);
              },
            },
          ],
          else: {
            label: "finish",
            description: "Use an exact top-up for the final gap.",
            async run(current, branchContext) {
              return workflow.runNode(finishBoostNode, { ...current, iteration }, branchContext);
            },
          },
        });

        return workflow.runNode(auditBoostNode, { ...routed, iteration }, loopContext);
      },
    });

    const result = await workflow.runStreamNode(outputNode, whileResult, context);
    if (result.output === undefined) {
      throw new workflow.HarnessError({
        type: "execution",
        message: "Loop output was not created.",
      });
    }

    return result.output;
  },
});

export const executor = workflow.defineExecutor<LoopInput, LoopOutputPayload>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    workflow.defineEntrypoint<LoopInput, LoopOutputPayload>({
      id: "main",
      title: "Loop",
      workflow: loopWorkflow,
      params: [
        {
          name: "rounds",
          flag: "--rounds",
          type: "number",
          required: false,
          defaultValue: "3",
          description: "How many items the runFor loop should process.",
        },
        {
          name: "target",
          flag: "--target",
          type: "number",
          required: false,
          defaultValue: "18",
          description: "Total score the runWhile loop should reach.",
        },
      ],
      createInput({ args }) {
        return parseLoopInput(args);
      },
    }),
  ],
});

export { loopWorkflow as workflow };
export default loopWorkflow;

function createLoopOutputContent(input: LoopState): string {
  return [
    `Loop result: ${input.total}/${input.target}`,
    ...input.steps.map((step) => `- ${step}`),
  ].join("\n") + "\n";
}

function parseLoopInput(args: string[]): LoopInput {
  let rounds = 3;
  let target = 18;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--rounds") {
      rounds = Number(args[++index] ?? rounds);
    } else if (arg === "--target") {
      target = Number(args[++index] ?? target);
    }
  }

  return { rounds, target };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampBoost(value: number, remaining: number): number {
  return Math.max(0, Math.min(value, remaining));
}
