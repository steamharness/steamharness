interface Input { action: "read" | "write" | "call"; value: string }
interface Output { errCode: number; errMessage: string; value: unknown }

const project = steamharness.defineProject<Input, Output>({
  name: "database-space-demo",
  async run(input, context) {
    const knowledge = context.knowledgeBases.get("data");
    if (input.action === "write") {
      const previous = await knowledge.getDocument("example");
      if (previous) await knowledge.editDocument({ id: "example", markdown: input.value, expectedRevision: previous.revision });
      else await knowledge.createDocument({ id: "example", title: "Shared example", markdown: input.value });
    }
    const value = input.action === "call"
      ? await context.entries.get("reader").runEntrypoint("main", ["--action", "read"])
      : await knowledge.getDocument("example");
    return { errCode: 0, errMessage: "", value };
  },
});

export const executor = steamharness.defineExecutor({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [steamharness.defineEntrypoint({
    id: "main", title: "Shared database", workflow: project,
    params: [
      { name: "action", flag: "--action", type: "string", defaultValue: "read", description: "read, write, or call the reader entry" },
      { name: "value", flag: "--value", type: "string", defaultValue: "Hello" },
    ],
    createInput({ paramValues }) { return { action: paramValues.action as Input["action"], value: String(paramValues.value ?? "Hello") }; },
  })],
});
