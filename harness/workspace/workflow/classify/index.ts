import type {
  ClassifyCategoryResult,
  ClassifyInput,
  ClassifyOutputPayload,
} from "./interface";

const llmProvider = steamharness.createLLMProviderRef("default", () => {
  return steamharness.createLLMProviderFromConfig();
});
const CLASSIFICATION_RESULT_ITEM_ID = "classification-result";

const userDescription = [
  "你是一个 uniapp / uni-app x / unicloud 问题鉴别专家。",
  "",
  "请根据用户输入的问题内容，判断该问题属于以下哪一类：",
  "",
  "- uniapp",
  "- uni-app x",
  "- unicloud",
  "",
  "判断时需要关注用户问题的核心含义，而不是只匹配关键词。",
  "",
  "如果用户问题中同时出现多个相关概念，请选择最符合实际问题含义、最能代表用户真实诉求的一个类别，切勿只根据第一个出现的概念直接输出。",
  "",
  "最终只输出一个分类结果，不要输出解释、分析过程或其他内容。",
].join("\n");

const inputNode = steamharness.createInputNode<ClassifyInput, ClassifyInput>({
  name: "classification-input",
  parse(input) {
    return input.trim();
  },
});

const classifierNode = steamharness.createQuestionClassifierNode({
  name: "uni-question-classifier",
  provider: llmProvider,
  userDescription,
  categories: [
    {
      name: "uniapp",
      description: [
        "用户的内容中提到了 uniapp 或者 uni-app 那么就算为 uniapp。",
        "用户内容中提到了：页面类型是 vue/nvue，使用 js 或者是 ts。",
        "uniapp 可以使用 uts，但是 uts 需要作为插件出现。",
        "用户内容提到了：(微信/支付宝/百度/抖音/飞书/QQ/快手/钉钉/淘宝/京东/小红书)小程序。",
        "",
        "特殊情况：",
        "- uni 小程序 SDK 不算为 uniapp",
        "- 鸿蒙 Next, 鸿蒙, HarmonyOS 算为 uniapp",
        "- 鸿蒙元服务 算为 uniapp",
        "- uni 安全加固 算为 uniapp",
        "- uni-ui 算为 uniapp",
      ].join("\n"),
    },
    {
      name: "uni-app x",
      description: [
        "用户的内容中提到了 uniapp-x 或者 uniappx，uni-app x 这类的内容。",
        "用户提到了 uvue，uts。",
        "用户提到了 kotlin, swift 算 uni-app x。",
      ].join("\n"),
    },
    {
      name: "unicloud",
      description: [
        "unicloud 是一个后端的开发框架，由云函数，云对象，云数据库，扩展数据库等内容构成，可以与 uniapp 和 uniappx 进行联动，由阿里云、腾讯云、支付宝云提供支持。",
        "",
        "unicloud 包括下方的内容：",
        "- uni-统计",
        "- uni 安全网络",
        "- app 一键登录",
        "- app 实人认证",
        "- ip 防刷",
        "- 内容安全审查",
        "- uni 安全",
        "- uni 云开发软件版",
        "- uni 直播",
        "- uni-cdn",
        "- push",
        "- redis",
        "- uni-config-center 配置中心",
        "- uni-id 用户体系",
        "- uni-starter",
        "- uni-admin",
        "- uni-upgrade-center App 升级中心",
        "- uni-pay 统一支付",
        "- uni-cms 内容管理",
        "- uni-ai-chat ai 聊天示例",
        "- uni-ai-x 原生 ai 聊天插件",
        "- uni-im 即时通信",
        "- uni-ad-admin",
        "- uSearch 云端一体搜索",
        "- uni-captcha 图形验证码",
        "- uni-sec-check 内容安全",
        "- 统一发行页面",
        "- uni-cloud-router",
        "- uni-open-bridge 微信支付宝等三方凭据管理",
        "- uni-cloud-s2s 传统服务器与 uniCloud 安全通信",
        "- uni-subscribemsg 订阅消息发送",
        "- uni-map 地图",
        "- 前端网页托管",
      ].join("\n"),
    },
  ] as const,
  settings: {
    maxOutputTokens: 50,
  },
});

const outputNode = steamharness.createOutputNode<ClassifyCategoryResult, ClassifyOutputPayload>({
  name: "classification-output",
  async *stream(category) {
    // String chunks create host-local fallback item ids. Use a stable
    // item id so live App output and report.json merge into one result.
    yield steamharness.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: CLASSIFICATION_RESULT_ITEM_ID,
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });
    yield steamharness.createOutputItemChunk({
      type: "output_item_delta",
      itemId: CLASSIFICATION_RESULT_ITEM_ID,
      delta: category,
    });
    yield steamharness.createOutputItemChunk({
      type: "output_item_end",
      itemId: CLASSIFICATION_RESULT_ITEM_ID,
    });
  },
  format(stream) {
    const category = readOutputItemText(stream.items, CLASSIFICATION_RESULT_ITEM_ID) as ClassifyCategoryResult;

    return {
      ...steamharness.createOutputPayload({
        items: stream.items,
      }),
      category,
      success: category !== "",
    };
  },
});

export const classifyProject = steamharness.defineProject<ClassifyInput, ClassifyOutputPayload>({
  name: "classify",
  async run(input, context) {
    const question = await steamharness.runNode(inputNode, input, context);
    const category = await steamharness.runNode(classifierNode, question, context);
    const result = await steamharness.runStreamNode(outputNode, category, context);

    return requireOutput(result.output);
  },
});

export const executor = steamharness.defineExecutor<
  ClassifyInput,
  ClassifyOutputPayload
>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    steamharness.defineEntrypoint<ClassifyInput, ClassifyOutputPayload>({
      id: "main",
      title: "Classify",
      workflow: classifyProject,
      tokenUsage: {
        enabled: true,
        display: true,
      },
      params: [
        {
          name: "query",
          flag: "--query",
          type: "positional",
          required: false,
          description: "Text to classify.",
        },
      ],
      createInput({ args }) {
        return args.join(" ");
      },
    }),
  ],
});

export { classifyProject as workflow };
export default classifyProject;

function readOutputItemText(
  items: Array<{ id: string; content: unknown }>,
  itemId: string,
): string {
  const item = items.find((candidate) => candidate.id === itemId);
  return typeof item?.content === "string" ? item.content.trim() : "";
}

function requireOutput(output: ClassifyOutputPayload | undefined): ClassifyOutputPayload {
  if (output === undefined) {
    throw new Error("Output node did not produce output.");
  }

  return output;
}
