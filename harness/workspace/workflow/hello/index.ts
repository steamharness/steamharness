import type { HelloInput, HelloOutputPayload } from "./interface";

const llmProvider = workflow.createLLMProviderRef("default", () => {
  return workflow.createLLMProviderFromEnv();
});

const llmNode = workflow.createLLMStreamNode<HelloInput>({
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

const outputNode = workflow.createOutputNode<string, HelloOutputPayload>({
  name: "hello-output",
  format(content) {
    const answer = content.trim();
    return {
      ...workflow.createOutputPayload({
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

export const helloWorkflow = workflow.defineWorkflow<HelloInput, HelloOutputPayload>({
  name: "hello",
  async run(input, context) {
    const llmResult = await workflow.runStreamNode(llmNode, input, context);
    const content = llmResult.output ?? "";

    return workflow.runNode(outputNode, content, context);
  },
});

export const executor = workflow.defineExecutor<HelloInput, HelloOutputPayload>(
  {
    projectType: "workflow",
    defaultEntrypoint: "main",
    entrypoints: [
      workflow.defineEntrypoint<HelloInput, HelloOutputPayload>({
        id: "main",
        title: "Hello",
        workflow: helloWorkflow,
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

export { helloWorkflow as workflow };
export default helloWorkflow;
