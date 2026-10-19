import type { DetailsOutputInput, DetailsOutputPayload } from "./interface";

const inputNode = steamharness.createInputNode<DetailsOutputInput, DetailsOutputInput>({
  name: "details-input",
  parse(input) {
    return {
      icon: normalizeIcon(input.icon),
      title: input.title.trim() || "Details output",
      content: input.content.trim() || "这里是折叠内容。",
    };
  },
});

const detailsOutputNode = steamharness.createDetailsOutputNode<DetailsOutputInput, DetailsOutputPayload>({
  name: "output",
  metadata: {
    title: "Details Output",
    type: "details-output",
    version: "1.0.0",
  },
});

export const detailsOutputProject = steamharness.defineProject<DetailsOutputInput, DetailsOutputPayload>({
  name: "details-output",
  async run(input, context) {
    const parsed = await steamharness.runNode(inputNode, input, context);
    return steamharness.runNode(detailsOutputNode, parsed, context);
  },
});

export const executor = steamharness.defineExecutor<
  DetailsOutputInput,
  DetailsOutputPayload
>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    steamharness.defineEntrypoint<DetailsOutputInput, DetailsOutputPayload>({
      id: "main",
      title: "Details Output",
      workflow: detailsOutputProject,
      params: [
        {
          name: "icon",
          flag: "--icon",
          type: "string",
          required: false,
          defaultValue: "info",
          description: "选择 summary 左侧的预置 icon。",
          control: "radio",
          options: [
            {
              value: "info",
              label: "Info",
              description: "General information block.",
            },
            {
              value: "success",
              label: "Success",
              description: "Successful result block.",
            },
            {
              value: "warning",
              label: "Warning",
              description: "Warning or caution block.",
            },
            {
              value: "error",
              label: "Error",
              description: "Error or failed result block.",
            },
            { value: "note", label: "Note", description: "Plain note block." },
            {
              value: "code",
              label: "Code",
              description: "Code or debug block.",
            },
            {
              value: "list",
              label: "List",
              description: "Checklist or list block.",
            },
            {
              value: "quote",
              label: "Quote",
              description: "Quoted content block.",
            },
            { value: "none", label: "None", description: "No icon." },
          ],
        },
        {
          name: "title",
          flag: "--title",
          type: "string",
          required: false,
          defaultValue: "点击展开",
          description: "折叠块标题。",
        },
        {
          name: "content",
          flag: "--content",
          type: "string",
          required: false,
          defaultValue: "这里是被折叠的内容。\n\n- 列表\n- **加粗**\n- `代码`",
          description: "折叠块正文，支持 Markdown。",
        },
      ],
      createInput({ args }) {
        return parseInput(args);
      },
    }),
  ],
});

export { detailsOutputProject as workflow };
export default detailsOutputProject;

const iconValues: DetailsOutputInput["icon"][] = [
  "info",
  "success",
  "warning",
  "error",
  "note",
  "code",
  "list",
  "quote",
  "none",
];

function parseInput(args: string[]): DetailsOutputInput {
  let icon: DetailsOutputInput["icon"] = "info";
  let title = "点击展开";
  let content = "这里是被折叠的内容。\n\n- 列表\n- **加粗**\n- `代码`";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--icon") {
      icon = normalizeIcon(args[++index]);
    } else if (arg === "--title") {
      title = args[++index] ?? title;
    } else if (arg === "--content") {
      content = args[++index] ?? content;
    }
  }

  // Keep this sample focused on the App details-output form: icon radio, title input, and content input.
  return { icon, title, content };
}

function normalizeIcon(value: unknown): DetailsOutputInput["icon"] {
  return iconValues.includes(value as DetailsOutputInput["icon"])
    ? value as DetailsOutputInput["icon"]
    : "info";
}
