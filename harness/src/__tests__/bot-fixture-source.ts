/** An isolated, offline model for tests that exercise the real project loader. */
export function botFixtureSource(options: { prepare?: string; properties?: string; response?: string } = {}): string {
  return `
    import { fauxProvider, createModels, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
    const provider = fauxProvider({ models: [{ id: "fixture", name: "Fixture", contextWindow: 4096, maxTokens: 100 }] });
    const models = createModels(); models.setProvider(provider.provider);
    provider.setResponses(Array.from({ length: 32 }, () => () => fauxAssistantMessage(${JSON.stringify(options.response ?? "Fixture answer")})));
    export const executor = steamharness.defineBot({
      agent: { models, resolvedModel: models.getModel("faux", "fixture"), tools: [] },
      async prepareInput(input, context) {
        ${options.prepare ?? 'return { ...input, prompt: input.prompt || "Fixture question" };'}
      },
      ${options.properties ?? ""}
    });
    export default executor;
  `;
}
