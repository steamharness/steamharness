import type { HelloInput, HelloOutputPayload } from "./interface";

const llmProvider = steamharness.createLLMProviderRef("default", () => {
  return steamharness.createLLMProviderFromConfig();
});

const llmNode = steamharness.createLLMStreamNode<HelloInput>({
  name: "hello-llm",
  provider: llmProvider,
  mapInput() {
    return {
      system: "You are a concise assistant named yuhe.",
      prompt: "hello",
      maxOutputTokens: 200,
      temperature: 0.2,
    };
  },
});

const outputNode = steamharness.createOutputNode<string, HelloOutputPayload>({
  name: "hello-output",
  format(content) {
    const answer = content.trim();
    return {
      ...steamharness.createOutputPayload({
        items: [{
          title: "Hello",
          content: answer,
          contentType: "markdown",
          collapsed: false,
        }],
      }),
      success: true,
    };
  },
});

export const helloProject = steamharness.defineProject<HelloInput, HelloOutputPayload>({
  name: "hello",
  async run(input, context) {
    const llmResult = await steamharness.runStreamNode(llmNode, input, context);
    const content = llmResult.output ?? "";

    return steamharness.runNode(outputNode, content, context);
  },
});

export const executor = steamharness.defineExecutor<HelloInput, HelloOutputPayload>(
  {
    projectType: "workflow",
    defaultEntrypoint: "main",
    entrypoints: [
      steamharness.defineEntrypoint<HelloInput, HelloOutputPayload>({
        id: "main",
        title: "Hello",
        workflow: helloProject,
        tokenUsage: {
          enabled: true,
          display: true,
        },
        createInput() {
          return {};
        },
      }),
    ],
  },
);

export { helloProject as workflow };
export default helloProject;
