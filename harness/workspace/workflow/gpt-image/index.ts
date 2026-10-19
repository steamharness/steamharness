import type {
  GptImageBackground,
  GptImageFormat,
  GptImageInput,
  GptImageInputFidelity,
  GptImageModeration,
  GptImageOutputPayload,
  GptImageParsedInput,
  GptImageQuality,
  GptImageRequest,
  GptImageRunner,
  GptImageRunnerInput,
  GptImageRunnerResult,
  GptImageSize,
  FileReference,
  ResolvedFile,
} from "./interface";

const model = "gpt-image-2";
const defaultPrompt = "Generate a crisp icon-style image of a workflow node creating a tiny landscape.";
const acceptedImageTypes = ["image/png", "image/jpeg", "image/webp"];
const maxImageInputs = 16;
const GPT_IMAGE_PROGRESS_ITEM_ID = "gpt-image-progress";
const GPT_IMAGE_RESULT_ITEM_ID = "gpt-image-result";

const inputNode = workflow.createInputNode<GptImageInput, GptImageParsedInput>({
  name: "gpt-image-input",
  parse(input) {
    const prompt = input.prompt.trim() || defaultPrompt;
    const outputFormat = readEnum<GptImageFormat>(
      input.outputFormat,
      ["png", "jpeg", "webp"],
      "outputFormat",
      "png",
    );
    const background = readEnum<GptImageBackground>(
      input.background,
      ["auto", "opaque", "transparent"],
      "background",
      "auto",
    );

    if (background === "transparent") {
      throw new workflow.HarnessError({
        type: "input_validation",
        message: "gpt-image-2 does not support transparent background. Use auto or opaque.",
        nodeName: "gpt-image-input",
      });
    }

    return {
      errCode: 0,
      errMessage: "",
      prompt,
      images: input.images,
      size: normalizeSize(input.size),
      quality: readEnum<GptImageQuality>(
        input.quality,
        ["auto", "low", "medium", "high"],
        "quality",
        "auto",
      ),
      outputFormat,
      outputCompression: normalizeCompression(input.outputCompression, outputFormat),
      background,
      inputFidelity: readEnum<GptImageInputFidelity>(
        input.inputFidelity,
        ["low", "high"],
        "inputFidelity",
        "low",
      ),
      moderation: readEnum<GptImageModeration>(
        input.moderation,
        ["auto", "low"],
        "moderation",
        "auto",
      ),
      imageRunner: input.imageRunner,
    };
  },
});

const imageInputNode = workflow.createFileInputNode({
  name: "gpt-image-input-images",
  accept: acceptedImageTypes,
  multiple: true,
});

const generateNode = workflow.createOutputNode<GptImageRequest, GptImageOutputPayload>({
  name: "gpt-image-output",
  async *stream(input) {
    // Keep progress as its own stable item so the final generated
    // image item does not duplicate the live text item in App conversations.
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: GPT_IMAGE_PROGRESS_ITEM_ID,
        title: "Progress",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_delta",
      itemId: GPT_IMAGE_PROGRESS_ITEM_ID,
      delta: "Generating image with gpt-image-2...\n",
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: GPT_IMAGE_PROGRESS_ITEM_ID,
    });
  },
  async format(_stream, input, context) {
    const result = await runGptImage(input, readContextImageRunner(context));
    const content = formatImageMarkdown({
      input,
      result,
    });
    const attachments = input.currentImages.map((file) => file.toJSON());
    await context.conversation.appendMessage({
      role: "user",
      content: input.prompt,
      metadata: {
        attachments,
      },
    });
    await context.conversation.appendMessage({
      role: "assistant",
      content: createAssistantConversationContent(input, result),
      metadata: {
        mode: input.mode,
        model,
        imageCount: input.resolvedImages.length,
        inputImageCount: input.currentImages.length,
        contextImageCount: input.contextImages.length,
        mimeType: result.mimeType,
        revisedPrompt: result.revisedPrompt,
      },
    });
    if (input.conversationTitle !== undefined) {
      await context.conversation.setTitle(input.conversationTitle);
    }
    const state = await context.conversation.getValue();

    return {
      ...workflow.createOutputPayload({
        items: [{
          id: GPT_IMAGE_RESULT_ITEM_ID,
          title: "Generated Image",
          content,
          contentType: "markdown",
          collapsed: false,
          iconPreset: "success",
        }],
      }),
      errCode: 0,
      errMessage: "",
      conversationId: state.conversationId,
      historyLength: state.messages.length,
      conversationMessages: state.messages.length,
      contextMessageCount: input.contextMessageCount,
      mode: input.mode,
      model,
      prompt: input.prompt,
      modelPrompt: input.modelPrompt,
      revisedPrompt: result.revisedPrompt,
      imageCount: input.resolvedImages.length,
      inputImageCount: input.currentImages.length,
      contextImageCount: input.contextImages.length,
      size: input.size,
      quality: input.quality,
      outputFormat: input.outputFormat,
      outputCompression: input.outputCompression,
      background: input.background,
      inputFidelity: input.inputFidelity,
      moderation: input.moderation,
      mimeType: result.mimeType,
      dataUrl: `data:${result.mimeType};base64,${result.b64Json}`,
    };
  },
});

export const gptImageWorkflow = workflow.defineWorkflow<GptImageInput, GptImageOutputPayload>({
  name: "gpt-image",
  async run(input, context) {
    const parsed = await workflow.runNode(inputNode, input, context);
    const conversationState = await context.conversation.getValue();
    const currentImages = await workflow.runNode(imageInputNode, parsed.images, context);
    const contextImages = await resolveConversationContextImages(
      conversationState.messages,
      currentImages,
      context.files,
    );
    const resolvedImages = mergeResolvedImages(currentImages, contextImages, maxImageInputs);
    const request: GptImageRequest = {
      ...parsed,
      resolvedImages,
      currentImages,
      contextImages,
      mode: resolvedImages.length > 0 ? "edit" : "generate",
      modelPrompt: createModelPrompt(parsed.prompt, conversationState.messages),
      contextMessageCount: conversationState.messages.length,
      conversationTitle: conversationState.messages.length === 0
        ? createConversationTitle(parsed.prompt)
        : undefined,
    };
    const result = await workflow.runStreamNode(generateNode, request, context);

    return requireOutput(result.output);
  },
});

export const executor = workflow.defineExecutor<GptImageInput, GptImageOutputPayload>({
  projectType: "conversation",
  workflow: gptImageWorkflow,
  conversation: {
        // 第二阶段把 gpt-image conversation 示例迁到 shared 默认输入框协议。
    attachments: {
      images: true,
    },
  },
  registry: [
    { name: "generate-image", node: generateNode, stream: true },
  ],
  params: [
    {
      kind: "auxiliary",
      id: "advanced",
      label: "Advanced",
      fields: [
        {
          name: "size",
          flag: "--size",
          type: "string",
          required: false,
          defaultValue: "1024x1024",
          control: "select",
          options: [
            { value: "1024x1024", label: "Square" },
            { value: "1536x1024", label: "Landscape" },
            { value: "1024x1536", label: "Portrait" },
            { value: "auto", label: "Auto" },
          ],
          description: "Output image size.",
        },
        {
          name: "quality",
          flag: "--quality",
          type: "string",
          required: false,
          defaultValue: "auto",
          control: "select",
          options: [
            { value: "auto", label: "Auto" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
          description: "Generation quality.",
        },
        {
          name: "outputFormat",
          flag: "--output-format",
          type: "string",
          required: false,
          defaultValue: "png",
          control: "select",
          options: [
            { value: "png", label: "PNG" },
            { value: "jpeg", label: "JPEG" },
            { value: "webp", label: "WebP" },
          ],
          description: "Generated image format.",
        },
        {
          name: "outputCompression",
          flag: "--output-compression",
          type: "number",
          required: false,
          defaultValue: "100",
          description: "JPEG/WebP compression level, 0-100.",
        },
        {
          name: "background",
          flag: "--background",
          type: "string",
          required: false,
          defaultValue: "auto",
          control: "radio",
          options: [
            { value: "auto", label: "Auto" },
            { value: "opaque", label: "Opaque" },
            { value: "transparent", label: "Transparent", description: "Rejected for gpt-image-2." },
          ],
          description: "Background handling. gpt-image-2 supports auto or opaque.",
        },
        {
          name: "inputFidelity",
          flag: "--input-fidelity",
          type: "string",
          required: false,
          defaultValue: "low",
          control: "radio",
          options: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
          description: "How closely edits should preserve input image details.",
        },
        {
          name: "moderation",
          flag: "--moderation",
          type: "string",
          required: false,
          defaultValue: "auto",
          control: "radio",
          options: [
            { value: "auto", label: "Auto" },
            { value: "low", label: "Low" },
          ],
          description: "Image moderation strictness.",
        }
      ],
    },
  ],
  createInput({ args }) {
    return parseInput(args);
  },
  createContext({ env }) {
    const imageRunner = createEnvImageRunner(env);

    return imageRunner === undefined
      ? {}
      : {
          metadata: {
            gptImageRunner: imageRunner,
          },
        };
  },
});

export { gptImageWorkflow as workflow };
export default gptImageWorkflow;

async function runGptImage(
  input: GptImageRequest,
  contextRunner?: GptImageRunner,
): Promise<GptImageRunnerResult> {
  const runner = input.imageRunner ?? contextRunner ?? createOpenAIImageRunner();
  const result = await runner({
    mode: input.mode,
    model,
    prompt: input.modelPrompt,
    images: input.resolvedImages,
    size: input.size,
    quality: input.quality,
    outputFormat: input.outputFormat,
    outputCompression: input.outputCompression,
    background: input.background,
    inputFidelity: input.inputFidelity,
    moderation: input.moderation,
    apiKey: readOptionalEnv("OPENAI_API_KEY", "LLM_API_KEY"),
    baseURL: readOptionalEnv("OPENAI_BASE_URL", "LLM_BASE_URL"),
  });

  if (result.b64Json.trim() === "") {
    throw new workflow.HarnessError({
      type: "provider_call",
      message: "OpenAI image response did not include base64 image data.",
      nodeName: "gpt-image-output",
    });
  }

  return {
    ...result,
    mimeType: result.mimeType || `image/${input.outputFormat}`,
  };
}

function createOpenAIImageRunner(): GptImageRunner {
  return async (input) => {
    const apiKey = input.apiKey;
    if (apiKey === undefined) {
      throw new workflow.HarnessError({
        type: "input_validation",
        message: "Missing required environment variable: OPENAI_API_KEY.",
        nodeName: "gpt-image-output",
        metadata: {
          aliases: ["LLM_API_KEY"],
        },
      });
    }

    const { default: OpenAI, toFile } = await import("openai");
    const client = new OpenAI({
      apiKey,
      baseURL: input.baseURL,
    });
    const baseParams = createImageParams(input);
    const response = input.mode === "edit"
      ? await client.images.edit({
          ...baseParams,
          image: await Promise.all(input.images.map(async (file) =>
            toFile(await file.readBuffer(), file.name, {
              type: file.mimeType,
            })
          )),
          input_fidelity: input.inputFidelity,
        })
      : await client.images.generate(baseParams);
    const image = response.data?.[0];

    return {
      b64Json: image?.b64_json ?? "",
      mimeType: `image/${input.outputFormat}`,
      revisedPrompt: image?.revised_prompt,
    };
  };
}

function createImageParams(input: GptImageRunnerInput) {
  return {
    model: input.model,
    prompt: input.prompt,
    size: input.size,
    quality: input.quality,
    output_format: input.outputFormat,
    ...(input.outputCompression === undefined ? {} : { output_compression: input.outputCompression }),
    background: input.background,
    moderation: input.moderation,
  };
}

function readContextImageRunner(context: {
  metadata?: Record<string, unknown>;
}): GptImageRunner | undefined {
  const runner = context.metadata?.gptImageRunner;
  return typeof runner === "function" ? runner as GptImageRunner : undefined;
}

function createEnvImageRunner(env: NodeJS.ProcessEnv): GptImageRunner | undefined {
  if (env.GPT_IMAGE_MOCK !== "1") {
    return undefined;
  }

  return async (input) => {
    // keeps this external-service sample in the default offline
    // workspace suite; real image calls stay opt-in through normal env keys.
    if (env.GPT_IMAGE_MOCK_TRACE_FILE !== undefined) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(env.GPT_IMAGE_MOCK_TRACE_FILE, `${JSON.stringify({
        mode: input.mode,
        prompt: input.prompt,
        imageIds: input.images.map((file) => file.id),
      })}\n`, "utf8");
    }

    return {
      b64Json: env.GPT_IMAGE_MOCK_B64 ?? "Z3B0LWltYWdlLWZpeHR1cmU=",
      mimeType: env.GPT_IMAGE_MOCK_MIME_TYPE ?? `image/${input.outputFormat}`,
      revisedPrompt: env.GPT_IMAGE_MOCK_REVISED_PROMPT ?? input.prompt,
    };
  };
}

async function resolveConversationContextImages(
  messages: Array<{ role: string; metadata?: Record<string, unknown> }>,
  currentImages: ResolvedFile[],
  files: { resolveFile(reference: FileReference): Promise<ResolvedFile> } | undefined,
): Promise<ResolvedFile[]> {
  if (files === undefined || currentImages.length >= maxImageInputs) {
    return [];
  }

  const seen = new Set(currentImages.map((file) => file.id));
  const contextImages: ResolvedFile[] = [];
  for (const reference of readRecentConversationImageReferences(messages)) {
    if (seen.has(reference.id)) {
      continue;
    }
    seen.add(reference.id);

    try {
      contextImages.push(await files.resolveFile(reference));
    } catch {
      // keeps the default gpt-image suite offline/reproducible:
      // missing historical attachments should not break the latest text turn.
    }

    if (currentImages.length + contextImages.length >= maxImageInputs) {
      break;
    }
  }

  return contextImages;
}

function readRecentConversationImageReferences(
  messages: Array<{ role: string; metadata?: Record<string, unknown> }>,
): FileReference[] {
  return messages
    .slice()
    .reverse()
    .flatMap((message) => {
      if (message.role !== "user") {
        return [];
      }
      const attachments = Array.isArray(message.metadata?.attachments)
        ? message.metadata.attachments
        : [];

      return attachments.flatMap((attachment) => {
        try {
          const reference = normalizeFileReference(attachment);
          return reference.kind === "image" || reference.mimeType.startsWith("image/")
            ? [reference]
            : [];
        } catch {
          return [];
        }
      });
    });
}

function mergeResolvedImages(
  currentImages: ResolvedFile[],
  contextImages: ResolvedFile[],
  limit: number,
): ResolvedFile[] {
  const merged: ResolvedFile[] = [];
  const seen = new Set<string>();

  for (const image of [...currentImages, ...contextImages]) {
    if (seen.has(image.id)) {
      continue;
    }
    seen.add(image.id);
    merged.push(image);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

function createModelPrompt(
  prompt: string,
  messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>,
): string {
  const contextLines = messages
    .flatMap(formatConversationMessageForPrompt)
    .slice(-8);

  if (contextLines.length === 0) {
    return prompt;
  }

  return [
    "Use the previous image-generation conversation as context.",
    "Preserve established visual decisions unless the latest request changes them.",
    "",
    "Previous conversation:",
    ...contextLines.map((line, index) => `${index + 1}. ${line}`),
    "",
    "Latest image request:",
    prompt,
  ].join("\n");
}

function formatConversationMessageForPrompt(message: {
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}): string[] {
  if (message.role !== "user" && message.role !== "assistant") {
    return [];
  }

  const content = normalizeWhitespace(message.content);
  if (content === "") {
    return [];
  }

  const attachmentCount = Array.isArray(message.metadata?.attachments)
    ? message.metadata.attachments.length
    : 0;
  const attachmentSummary = attachmentCount > 0
    ? ` (${attachmentCount} reference image${attachmentCount === 1 ? "" : "s"})`
    : "";

  return [`${message.role}: ${truncateText(content, 640)}${attachmentSummary}`];
}

function createAssistantConversationContent(
  input: GptImageRequest,
  result: GptImageRunnerResult,
): string {
  const lines = [
    `Generated a ${input.mode} image for: ${input.prompt}`,
    `Images used: ${input.resolvedImages.length} (${input.currentImages.length} current, ${input.contextImages.length} context)`,
    `Format: ${result.mimeType}`,
  ];

  if (result.revisedPrompt !== undefined && result.revisedPrompt.trim() !== "") {
    lines.push(`Revised prompt: ${result.revisedPrompt}`);
  }

  return lines.join("\n");
}

function createConversationTitle(prompt: string): string {
  return truncateText(normalizeWhitespace(prompt), 56);
}

function parseInput(args: string[]): GptImageInput {
  const defaults = workflow.parseConversationDefaultInputArgs(args);
  const defaultMessage = defaults.message.trim();
  const input: GptImageInput = {
    prompt: defaults.message,
    images: defaults.images,
  };
  const promptParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    switch (arg) {
      case "--prompt":
        if (defaultMessage === "") {
          promptParts.push(requireArgValue(args, (index += 1), arg));
        } else {
          index += 1;
        }
        break;
      case "--images":
        input.images = parseImageReferences(requireArgValue(args, (index += 1), arg));
        break;
      case "--size":
        input.size = requireArgValue(args, (index += 1), arg);
        break;
      case "--quality":
        input.quality = requireArgValue(args, (index += 1), arg);
        break;
      case "--output-format":
        input.outputFormat = requireArgValue(args, (index += 1), arg);
        break;
      case "--output-compression":
        input.outputCompression = parseNumber(requireArgValue(args, (index += 1), arg), arg);
        break;
      case "--background":
        input.background = requireArgValue(args, (index += 1), arg);
        break;
      case "--input-fidelity":
        input.inputFidelity = requireArgValue(args, (index += 1), arg);
        break;
      case "--moderation":
        input.moderation = requireArgValue(args, (index += 1), arg);
        break;
      default:
        if (defaultMessage === "") {
          promptParts.push(arg);
        }
        break;
    }
  }

  if (defaultMessage === "") {
    input.prompt = promptParts.join(" ").trim() || defaultPrompt;
  }

  return input;
}

function parseImageReferences(value: string): FileReference[] {
  const trimmed = value.trim();
  if (trimmed === "") {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeFileReference);
    }
    return [normalizeFileReference(parsed)];
  } catch {
    return [{
      id: trimmed,
      name: trimmed,
      mimeType: guessImageMimeType(trimmed),
      size: 0,
      kind: "image",
      storage: "path",
      path: trimmed,
      createdAt: new Date().toISOString(),
    }];
  }
}

function normalizeFileReference(value: unknown): FileReference {
  if (!isRecord(value)) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: "Image file reference must be an object.",
      nodeName: "gpt-image-input",
    });
  }
  const id = readString(value.id);
  const name = readString(value.name) ?? id;
  if (id === undefined || name === undefined) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: "Image file reference requires id and name.",
      nodeName: "gpt-image-input",
    });
  }

  return {
    id,
    name,
    mimeType: readString(value.mimeType) ?? guessImageMimeType(name),
    size: readNumber(value.size) ?? 0,
    kind: value.kind === "file" ? "file" : "image",
    storage: readFileStorage(value.storage),
    workflowId: readString(value.workflowId),
    conversationId: readString(value.conversationId),
    createdAt: readString(value.createdAt) ?? new Date().toISOString(),
    url: readString(value.url),
    path: readString(value.path),
  };
}

function readFileStorage(value: unknown): FileReference["storage"] {
  return value === "local" || value === "server" || value === "url" ? value : "path";
}

function normalizeSize(value: string | undefined): GptImageSize {
  const normalized = normalizeOptionalString(value) ?? "1024x1024";
  if (normalized === "auto" || normalized === "1024x1024" || normalized === "1536x1024" || normalized === "1024x1536") {
    return normalized;
  }

  const match = normalized.match(/^(\d+)x(\d+)$/);
  if (!match) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: `Invalid image size "${normalized}". Use auto or WIDTHxHEIGHT.`,
      nodeName: "gpt-image-input",
    });
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width % 16 !== 0 || height % 16 !== 0 || width <= 0 || height <= 0) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: "Custom gpt-image-2 sizes must be positive and divisible by 16.",
      nodeName: "gpt-image-input",
    });
  }
  const ratio = width / height;
  if (ratio < 1 / 3 || ratio > 3) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: "Custom gpt-image-2 sizes must use an aspect ratio between 1:3 and 3:1.",
      nodeName: "gpt-image-input",
    });
  }

  return normalized as GptImageSize;
}

function normalizeCompression(
  value: number | undefined,
  format: GptImageFormat,
): number | undefined {
  if (format === "png") {
    return undefined;
  }
  const compression = value ?? 100;
  if (!Number.isInteger(compression) || compression < 0 || compression > 100) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: "Output compression must be an integer between 0 and 100.",
      nodeName: "gpt-image-input",
    });
  }
  return compression;
}

function readEnum<Value extends string>(
  value: string | undefined,
  allowed: readonly Value[],
  name: string,
  defaultValue: Value,
): Value {
  const normalized = normalizeOptionalString(value) ?? defaultValue;
  if ((allowed as readonly string[]).includes(normalized)) {
    return normalized as Value;
  }

  throw new workflow.HarnessError({
    type: "input_validation",
    message: `Invalid ${name} "${normalized}". Expected one of: ${allowed.join(", ")}.`,
    nodeName: "gpt-image-input",
  });
}

function formatImageMarkdown(input: {
  input: GptImageRequest;
  result: GptImageRunnerResult;
}): string {
  const dataUrl = `data:${input.result.mimeType};base64,${input.result.b64Json}`;
  const lines = [
    `![Generated image](${dataUrl})`,
    "",
    "### Parameters",
    "",
    `- Model: \`${model}\``,
    `- Mode: \`${input.input.mode}\``,
    `- Prompt: ${input.input.prompt}`,
    `- Input images: ${input.input.resolvedImages.length}`,
    `- Current images: ${input.input.currentImages.length}`,
    `- Context images: ${input.input.contextImages.length}`,
    `- Size: \`${input.input.size}\``,
    `- Quality: \`${input.input.quality}\``,
    `- Format: \`${input.input.outputFormat}\``,
    `- Background: \`${input.input.background}\``,
    `- Input fidelity: \`${input.input.inputFidelity}\``,
    `- Moderation: \`${input.input.moderation}\``,
  ];

  if (input.input.outputCompression !== undefined) {
    lines.push(`- Output compression: \`${input.input.outputCompression}\``);
  }
  if (input.result.revisedPrompt !== undefined && input.result.revisedPrompt.trim() !== "") {
    lines.push(`- Revised prompt: ${input.result.revisedPrompt}`);
  }

  return lines.join("\n");
}

function requireOutput<Output>(output: Output | undefined): Output {
  if (output === undefined) {
    throw new Error("GPT Image output node did not return output.");
  }
  return output;
}

function readOptionalEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = workflow.getEnv(key);
    if (value !== undefined && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function requireArgValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: `Missing value for ${flag}.`,
      nodeName: "gpt-image-input",
    });
  }
  return value;
}

function parseNumber(value: string, flag: string): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: `${flag} must be a number.`,
      nodeName: "gpt-image-input",
    });
  }
  return numberValue;
}

function guessImageMimeType(fileName: string): string {
  const normalized = fileName.toLowerCase();
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
