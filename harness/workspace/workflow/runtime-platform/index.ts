import type { RuntimePlatformInput, RuntimePlatformOutputPayload } from "./interface";

const outputNode = steamharness.createOutputNode<RuntimePlatformInput, RuntimePlatformOutputPayload>({
  name: "runtime-platform-output",
  format() {
    const platform = steamharness.getRuntimePlatform();
    const flags = {
      isCli: steamharness.isCli(),
      isDesktop: steamharness.isDesktop(),
    };

    return {
      ...steamharness.createOutputPayload({
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

export const runtimePlatformProject = steamharness.defineProject<RuntimePlatformInput, RuntimePlatformOutputPayload>({
  name: "runtime-platform",
  run(input, context) {
    // Sample workflow exercises all runtime platform helpers.
    return steamharness.runNode(outputNode, input, context);
  },
});

export const executor = steamharness.defineExecutor<
  RuntimePlatformInput,
  RuntimePlatformOutputPayload
>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    steamharness.defineEntrypoint<
      RuntimePlatformInput,
      RuntimePlatformOutputPayload
    >({
      id: "main",
      title: "Runtime Platform",
      workflow: runtimePlatformProject,
      createInput() {
        return {};
      },
    }),
  ],
});

export { runtimePlatformProject as workflow };
export default runtimePlatformProject;
