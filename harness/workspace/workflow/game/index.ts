import type {
  ArmorBrief,
  AttachmentBrief,
  GameArmor,
  GameAttachment,
  GameInput,
  GameMedicine,
  GameResultDraft,
  GameResultOutput,
  GameStory,
  GameWeapon,
  LoadoutPlan,
  MedicineBrief,
  MissionSeed,
  MissionStatus,
  WeaponBrief,
} from "./interface";

const llmProvider = workflow.createLLMProviderRef("default", () => {
  return workflow.createLLMProviderFromEnv();
});

const defaultTask = "城市攻坚战任务";
const weaponDescriptionLabel = "武器描述：";
const attachmentDescriptionLabel = "配件方案：";
const medicineDescriptionLabel = "药品策略：";
const armorDescriptionLabel = "护甲方案：";
const storyLabel = "剧情：";
const WEAPON_DESCRIPTION_ITEM_ID = "weapon-description";
const STORY_ITEM_ID = "story";
const GAME_RESULT_ITEM_ID = "game-result";

const inputNode = workflow.createInputNode<GameInput, MissionSeed>({
  name: "game-input",
  parse(input) {
    const task = input.trim() || defaultTask;
    const seed = hashText(task);

    return {
      errCode: 0,
      errMessage: "",
      task,
      intensity: normalizeSeed(seed, 3),
      stealth: normalizeSeed(seed, 11),
      range: normalizeSeed(seed, 19),
      attrition: normalizeSeed(seed, 29),
    };
  },
});

const weaponDescriptionOutputNode = workflow.createOutputNode<LoadoutPlan, WeaponBrief>({
  name: "weapon-description-output",
  async *stream(input, context) {
    // Keep streamed LLM text in stable items so App/report merging is
    // deterministic for every visible output node.
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: createTextOutputItem(WEAPON_DESCRIPTION_ITEM_ID, ""),
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_delta",
      itemId: WEAPON_DESCRIPTION_ITEM_ID,
      delta: weaponDescriptionLabel,
    });

    const provider = workflow.getLLMProvider(context, "weapon-description-output", llmProvider);
    for await (const chunk of provider.stream(createWeaponDescriptionInput(input))) {
      if (chunk.type === "text-delta") {
        yield workflow.createOutputItemChunk({
          type: "output_item_delta",
          itemId: WEAPON_DESCRIPTION_ITEM_ID,
          delta: chunk.text,
        });
      }
    }
    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: WEAPON_DESCRIPTION_ITEM_ID,
    });
  },
  format(stream, input) {
    const content = readOutputItemText(stream.items, WEAPON_DESCRIPTION_ITEM_ID);
    return {
      ...input,
      content,
      weaponDescription: stripLeadingLabel(content, weaponDescriptionLabel).trim(),
    };
  },
});

const attachmentAdviceNode = workflow.createLLMNode<WeaponBrief, AttachmentBrief>({
  name: "attachment-advice-llm",
  provider: llmProvider,
  mapInput(input) {
    return {
      system: "You are a tactical equipment designer for a game mission.",
      prompt: [
        "根据任务、武器和已选配件，生成一段中文配件战术建议。",
        "要求：",
        "- 只输出一段文字，不要写 JSON、标题或列表。",
        "- 说明配件如何影响枪口控制、隐蔽、弹匣容量或短点射节奏。",
        "",
        `任务: ${input.task}`,
        `路线: ${input.route}`,
        `武器: ${input.weapon}`,
        `武器描述: ${input.weaponDescription}`,
        `配件: ${input.attachment}`,
      ].join("\n"),
      maxOutputTokens: 240,
    };
  },
  mapOutput(output, input) {
    const text = output.text.trim();

    return {
      ...input,
      content: [input.content, "", `${attachmentDescriptionLabel}${text}`].join("\n").trim(),
      attachmentDescription: text,
    };
  },
});

const medicineAdviceNode = workflow.createLLMNode<AttachmentBrief, MedicineBrief>({
  name: "medicine-advice-llm",
  provider: llmProvider,
  mapInput(input) {
    return {
      system: "You are a combat medic balancing game equipment.",
      prompt: [
        "根据任务压力、装备和药品，生成一段中文战地医疗策略。",
        "要求：",
        "- 只输出一段文字，不要写 JSON、标题或列表。",
        "- 解释药品在推进、撤离或压制火力中的使用时机。",
        "",
        `任务: ${input.task}`,
        `路线: ${input.route}`,
        `武器: ${input.weapon}`,
        `配件建议: ${input.attachmentDescription}`,
        `药品: ${input.medicine}`,
        `损耗指数: ${input.attrition.toFixed(2)}`,
      ].join("\n"),
      maxOutputTokens: 240,
    };
  },
  mapOutput(output, input) {
    const text = output.text.trim();

    return {
      ...input,
      content: [input.content, "", `${medicineDescriptionLabel}${text}`].join("\n").trim(),
      medicineDescription: text,
    };
  },
});

const armorAdviceNode = workflow.createLLMNode<MedicineBrief, ArmorBrief>({
  name: "armor-advice-llm",
  provider: llmProvider,
  mapInput(input) {
    return {
      system: "You are a game armor and survivability designer.",
      prompt: [
        "根据任务、路线和护甲，生成一段中文护甲策略。",
        "要求：",
        "- 只输出一段文字，不要写 JSON、标题或列表。",
        "- 说明护甲如何影响机动、正面交火和撤离成功率。",
        "",
        `任务: ${input.task}`,
        `路线: ${input.route}`,
        `护甲: ${input.armor}`,
        `药品策略: ${input.medicineDescription}`,
      ].join("\n"),
      maxOutputTokens: 240,
    };
  },
  mapOutput(output, input) {
    const text = output.text.trim();

    return {
      ...input,
      content: [input.content, "", `${armorDescriptionLabel}${text}`].join("\n").trim(),
      armorDescription: text,
    };
  },
});

const storyOutputNode = workflow.createOutputNode<ArmorBrief, GameStory>({
  name: "story-output",
  async *stream(input, context) {
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: createTextOutputItem(STORY_ITEM_ID, ""),
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_delta",
      itemId: STORY_ITEM_ID,
      delta: storyLabel,
    });

    const provider = workflow.getLLMProvider(context, "story-output", llmProvider);
    for await (const chunk of provider.stream(createStoryInput(input))) {
      if (chunk.type === "text-delta") {
        yield workflow.createOutputItemChunk({
          type: "output_item_delta",
          itemId: STORY_ITEM_ID,
          delta: chunk.text,
        });
      }
    }
    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: STORY_ITEM_ID,
    });
  },
  format(stream, input) {
    const content = readOutputItemText(stream.items, STORY_ITEM_ID);
    return {
      ...input,
      content,
      story: stripLeadingLabel(content, storyLabel).trim(),
    };
  },
});

const missionStatusNode = workflow.createQuestionClassifierNode({
  name: "mission-status-classifier",
  provider: llmProvider,
  userDescription: [
    "你是一个城市攻坚战剧情结果判定器。",
    "请根据输入的剧情文本，判断任务是否已经成功完成。",
    "只允许输出 true 或 false。",
    "true 表示任务目标已经达成、关键地点已经控制、敌方威胁已经解除或行动已经明确成功。",
    "false 表示任务没有结束、结果未明确、行动失败、仍在交战、正在撤离或只描述了过程没有达成目标。",
    "不要输出解释、分析过程、JSON、Markdown 或其他内容。",
  ].join("\n"),
  categories: [
    {
      name: "true",
      description: "任务成功完成，目标已经达成，剧情有明确成功结果。",
    },
    {
      name: "false",
      description: "任务没有结束、结果不明确或任务失败。",
    },
  ] as const,
  settings: {
    maxOutputTokens: 20,
  },
});

const outputNode = workflow.createOutputNode<GameResultDraft, GameResultOutput>({
  name: "game-output",
  async *stream(input) {
    // Use a stable output item while streaming so App replaces the
    // live game result with the final report item instead of keeping both.
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: createGameResultItem(""),
    });
    for await (const char of streamText(input.content)) {
      yield workflow.createOutputItemChunk({
        type: "output_item_delta",
        itemId: GAME_RESULT_ITEM_ID,
        delta: char,
      });
    }
    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: GAME_RESULT_ITEM_ID,
    });
  },
  format(stream, input) {
    return {
      ...workflow.createOutputPayload({
        items: stream.items.length > 0 ? stream.items : [createGameResultItem(input.content.trim())],
      }),
      task: input.task,
      weapon: input.weapon,
      attachment: input.attachment,
      medicine: input.medicine,
      armor: input.armor,
      route: input.route,
      weaponDescription: input.weaponDescription,
      attachmentDescription: input.attachmentDescription,
      medicineDescription: input.medicineDescription,
      armorDescription: input.armorDescription,
      story: input.story,
      missionStatus: input.missionStatus,
      success: input.success,
    };
  },
});

export const gameWorkflow = workflow.defineWorkflow<GameInput, GameResultOutput>({
  name: "game",
  async run(input, context) {
    const seed = await workflow.runNode(inputNode, input, context);
    // Exercise runIf across equipment, medicine, and armor paths so the
    // App Diagram has multi-level branches and visible LLM work to render.
    const weaponPlan = await workflow.runIf(seed, context, {
      name: "Weapon branch",
      branches: [
        {
          label: "high intensity assault",
          condition: (mission) => mission.intensity >= 0.66,
          run: (mission) => createLoadoutPlan(mission, {
            weapon: "ak47",
            route: "assault",
          }),
        },
        {
          label: "stealth close quarter",
          condition: (mission) => mission.stealth >= 0.58,
          run: (mission) => createLoadoutPlan(mission, {
            weapon: "mp7",
            route: "stealth",
          }),
        },
      ],
      else: {
        label: "balanced rifle",
        run: (mission) => createLoadoutPlan(mission, {
          weapon: "m4a1",
          route: "support",
        }),
      },
    });
    const attachmentPlan = await workflow.runIf(weaponPlan, context, {
      name: "Attachment branch",
      branches: [
        {
          label: "long lane optics",
          condition: (plan) => plan.range >= 0.62,
          run: (plan) => ({ ...plan, attachment: "holo-sight" }),
        },
        {
          label: "silent breach",
          condition: (plan) => plan.route === "stealth",
          run: (plan) => ({ ...plan, attachment: "suppressor" }),
        },
      ],
      else: {
        label: "sustained fire",
        run: (plan) => ({ ...plan, attachment: "extended-mag" }),
      },
    });
    const weaponBrief = requireOutput(
      (await workflow.runStreamNode(weaponDescriptionOutputNode, attachmentPlan, context)).output,
    );
    const attachmentBrief = await workflow.runNode(attachmentAdviceNode, weaponBrief, context);
    const medicinePlan = await workflow.runIf(attachmentBrief, context, {
      name: "Medicine branch",
      branches: [
        {
          label: "heavy attrition kit",
          condition: (plan) => plan.attrition >= 0.7,
          async run(plan, runContext) {
            const armorPlan = await workflow.runIf(plan, runContext, {
              name: "Nested armor triage",
              branches: [
                {
                  label: "frontline heavy plate",
                  condition: (innerPlan) => innerPlan.intensity >= 0.72,
                  run: (innerPlan) => ({ ...innerPlan, medicine: "trauma-kit", armor: "heavy-plate" }),
                },
              ],
              else: {
                label: "mobile trauma kit",
                run: (innerPlan) => ({ ...innerPlan, medicine: "trauma-kit", armor: "light-plate" }),
              },
            });

            return armorPlan;
          },
        },
        {
          label: "fast push stimulant",
          condition: (plan) => plan.route === "assault",
          run: (plan) => ({ ...plan, medicine: "adrenaline", armor: "heavy-plate" }),
        },
      ],
      else: {
        label: "field dressing",
        run: (plan) => ({ ...plan, medicine: "field-bandage", armor: "recon-vest" }),
      },
    });
    const medicineBrief = await workflow.runNode(medicineAdviceNode, medicinePlan, context);
    const armorPlan = await workflow.runIf(medicineBrief, context, {
      name: "Armor branch",
      branches: [
        {
          label: "hold the avenue",
          condition: (plan) => plan.weapon === "ak47" || plan.medicine === "trauma-kit",
          run: (plan) => ({ ...plan, armor: "heavy-plate" as GameArmor }),
        },
        {
          label: "scout movement",
          condition: (plan) => plan.route === "stealth",
          run: (plan) => ({ ...plan, armor: "recon-vest" as GameArmor }),
        },
      ],
      else: {
        label: "balanced plate",
        run: (plan) => ({ ...plan, armor: "light-plate" as GameArmor }),
      },
    });
    const armorBrief = await workflow.runNode(armorAdviceNode, armorPlan, context);
    const gameStory = requireOutput(
      (await workflow.runStreamNode(storyOutputNode, armorBrief, context)).output,
    );
    const missionStatus = await workflow.runNode(missionStatusNode, gameStory.story, context);
    const result = await workflow.runStreamNode(
      outputNode,
      createMissionResult(gameStory, missionStatus),
      context,
    );

    return requireOutput(result.output);
  },
});

export const executor = workflow.defineExecutor<GameInput, GameResultOutput>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    workflow.defineEntrypoint<GameInput, GameResultOutput>({
      id: "main",
      title: "Game",
      workflow: gameWorkflow,
      tokenUsage: {
        enabled: true,
        display: true,
      },
      registry: [
        {
          name: "weapon-description",
          node: weaponDescriptionOutputNode,
          stream: true,
        },
        { name: "attachment-advice", node: attachmentAdviceNode },
        { name: "medicine-advice", node: medicineAdviceNode },
        { name: "armor-advice", node: armorAdviceNode },
        { name: "story", node: storyOutputNode, stream: true },
        { name: "mission-status", node: missionStatusNode },
        { name: "output", node: outputNode, stream: true },
      ],
      params: [
        {
          name: "task",
          flag: "--task",
          type: "positional",
          required: false,
          description: "游戏任务描述，默认为城市攻坚战。",
          defaultValue: "城市攻坚战",
        },
      ],
      createInput({ args }) {
        return args.join(" ");
      },
    }),
  ],
});

export { gameWorkflow as workflow };
export default gameWorkflow;

function createGameResultItem(content: string) {
  return createTextOutputItem(GAME_RESULT_ITEM_ID, content, "Game Result");
}

function createTextOutputItem(
  id: string,
  content: string,
  title = "Output",
) {
  return {
    id,
    title,
    content,
    contentType: "markdown" as const,
    collapsed: false,
  };
}

function readOutputItemText(
  items: Array<{ id: string; content: unknown }>,
  itemId: string,
): string {
  const item = items.find((candidate) => candidate.id === itemId);
  return typeof item?.content === "string" ? item.content.trim() : "";
}

async function* streamText(content: string): AsyncIterable<string> {
  for (const char of content) {
    yield char;
  }
}

function requireOutput<Output>(output: Output | undefined): Output {
  if (output === undefined) {
    throw new Error("Output node did not produce output.");
  }

  return output;
}

function createLoadoutPlan(
  input: MissionSeed,
  options: Pick<LoadoutPlan, "weapon" | "route">,
): LoadoutPlan {
  return {
    ...input,
    ...options,
    attachment: "extended-mag",
    medicine: "field-bandage",
    armor: "light-plate",
  };
}

function createWeaponDescriptionInput(input: LoadoutPlan) {
  return {
    system: "You are a firearms game-design writer. Keep details plausible and concise.",
    prompt: [
      "根据任务描述和选择的武器，生成一段中文武器描述。",
      "要求：",
      "- 只描述当前武器。",
      "- 必须涉及子弹、配件、射程参数等枪械信息。",
      "- 输出一段文字，不要写标题、JSON、Markdown 或解释。",
      "",
      `任务描述: ${input.task}`,
      `路线: ${input.route}`,
      `选择武器: ${input.weapon}`,
      `选择配件: ${input.attachment}`,
      `强度指数: ${input.intensity.toFixed(2)}`,
      `射程指数: ${input.range.toFixed(2)}`,
    ].join("\n"),
    maxOutputTokens: 300,
  };
}

function createStoryInput(input: ArmorBrief) {
  return {
    system: "You are a military fiction writer. Keep the writing cinematic but concise.",
    prompt: [
      "根据任务描述、装备和战术策略，生成一段城市攻坚战剧情。",
      "要求：",
      "- 只输出一段中文剧情。",
      "- 场景必须发生在城市攻坚战中。",
      "- 自然融入武器、配件、药品、护甲和路线，不要写成清单。",
      "- 不要输出标题、JSON、Markdown 或解释。",
      "",
      `任务描述: ${input.task}`,
      `路线: ${input.route}`,
      `武器: ${input.weapon}`,
      `配件: ${input.attachment}`,
      `药品: ${input.medicine}`,
      `护甲: ${input.armor}`,
      "",
      "武器描述:",
      input.weaponDescription,
      "",
      "配件方案:",
      input.attachmentDescription,
      "",
      "药品策略:",
      input.medicineDescription,
      "",
      "护甲方案:",
      input.armorDescription,
    ].join("\n"),
    maxOutputTokens: 520,
  };
}

function stripLeadingLabel(content: string, label: string): string {
  return content.startsWith(label) ? content.slice(label.length) : content;
}

function createMissionResult(story: GameStory, status: MissionStatus): GameResultDraft {
  const success = status === "true";
  const statusText = success ? "任务结束" : "任务失败";
  const content = [
    story.content,
    "",
    "装备总览：",
    `- 武器：${story.weapon}`,
    `- 配件：${story.attachment}`,
    `- 药品：${story.medicine}`,
    `- 护甲：${story.armor}`,
    "",
    `任务判定：${statusText}`,
  ].join("\n");

  return {
    errCode: 0,
    errMessage: "",
    content,
    task: story.task,
    weapon: story.weapon,
    attachment: story.attachment,
    medicine: story.medicine,
    armor: story.armor,
    route: story.route,
    weaponDescription: story.weaponDescription,
    attachmentDescription: story.attachmentDescription,
    medicineDescription: story.medicineDescription,
    armorDescription: story.armorDescription,
    story: story.story,
    missionStatus: status,
    success,
  };
}

function hashText(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function normalizeSeed(seed: number, salt: number): number {
  const value = Math.imul(seed ^ Math.imul(salt, 2654435761), 2246822519) >>> 0;

  return Number((value / 0xffffffff).toFixed(4));
}
