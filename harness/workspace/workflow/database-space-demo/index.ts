interface Input { action: "read" | "write" | "call"; value: string }
interface Output { errCode: number; errMessage: string; value: unknown }

const project = steamharness.defineProject<Input, Output>({
  name: "database-space-demo",
  async run(input, context) {
    const database = context.databases.get("data");
    if (input.action === "write") await database.transaction(async db => {
      await db.kv.setValue("example", input.value);
      if (await db.knowledge.getDocument("example")) await db.knowledge.editDocument({ id: "example", markdown: input.value });
      else await db.knowledge.createDocument({ id: "example", title: "Shared example", markdown: input.value });
    });
    const value = input.action === "call"
      ? await context.entries.get("reader").runEntrypoint("main", ["--action", "read"])
      : { kv: await database.kv.getValue("example"), document: await database.knowledge.getDocument("example") };
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
