import type { RuntimePlatformInput, RuntimePlatformOutputPayload } from "./interface";

const outputNode = workflow.createOutputNode<RuntimePlatformInput, RuntimePlatformOutputPayload>({
  name: "runtime-platform-output",
  format() {
    const platform = workflow.getRuntimePlatform();
    const flags = {
      isCli: workflow.isCli(),
      isDesktop: workflow.isDesktop(),
    };

    return {
      ...workflow.createOutputPayload({
        items: [{
          title: "Runtime Platform",
          content: {
            platform,
            ...flags,
          },
          contentType: "json",
          collapsed: false,
        }],
      }),
      platform,
      ...flags,
    };
  },
});

export const runtimePlatformWorkflow = workflow.defineWorkflow<RuntimePlatformInput, RuntimePlatformOutputPayload>({
  name: "runtime-platform",
  run(input, context) {
    // Sample workflow exercises all runtime platform helpers.
    return workflow.runNode(outputNode, input, context);
  },
});

export const executor = workflow.defineExecutor<
  RuntimePlatformInput,
  RuntimePlatformOutputPayload
>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    workflow.defineEntrypoint<
      RuntimePlatformInput,
      RuntimePlatformOutputPayload
    >({
      id: "main",
      title: "Runtime Platform",
      workflow: runtimePlatformWorkflow,
      createInput() {
        return {};
      },
    }),
  ],
});

export { runtimePlatformWorkflow as workflow };
export default runtimePlatformWorkflow;
