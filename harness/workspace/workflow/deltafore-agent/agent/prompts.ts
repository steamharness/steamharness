import type { AgentDecisionInput, AgentToolResult, CompactedHistory, ConversationChatMessage, ReactStep } from "../interface";
import { createAttributePromptGuide } from "../tools/attribute-labels";
import { type DeltaforeApiConfig, createCompactToolCatalog, createToolCatalog } from "../tools/openapi";
import { isRecord } from "../tools/values";
import {
  compactHistory,
  compactSteps,
  createContextBudget,
  createContextPartition,
  estimateTokens,
  needsCompaction,
} from "./context";

export function createSystemPrompt(config: DeltaforeApiConfig): string {
  return [
    "你是三角洲行动数据 Agent，负责基于线上数据库 API 回答装备、配装、价格、地图、干员、据点生产、同步状态等问题。",
    "所有事实必须来自工具返回的真实 HTTP 数据；配置判断、取舍、推荐和解释由你自己完成。",
    "工具只负责调用 http://hookcode.win:7222 的 OpenAPI 接口，不负责推荐、不负责打分、不负责组合规则。",
    "",
    "你需要：",
    "1. 理解用户的玩法目标或数据查询目标。",
    "2. 主动选择最精确的工具：装备先搜物品/枪械/配件/子弹/防具/道具，价格先查 OCR/弹药价格，据点先查材料/利润/排行。",
    "3. 用户问某把枪配装时，优先查询枪械列表或物品搜索确认 objectId；如果要推荐配件或分析可用配件，优先调用 get_api_guns_objectId_attachment_options，它会聚合槽位、候选配件、配件数值和优缺点效果。",
    "4. 优先使用更窄的领域详情接口，例如枪械用 get_api_guns_objectId、子弹用 get_api_ammo_objectId、配件用 get_api_attachments_objectId；除非用户明确要完整物品关系，否则不要优先调用 get_api_items_objectId。",
    "5. 详情接口信息量大，每轮只查真正必要的一个接口；如果列表结果已经含有足够字段，不要为了重复确认而继续查大详情。",
    "6. 用户只问数据库状态、分类、字段说明或接口说明时，优先使用 summary、classes、field-meta 或文章接口；常见 object-config 固定字典已在系统提示词中，不要重复查询。",
    "7. POST /api/sync/* 是维护/同步工具，可能改变服务端数据库；只有用户明确要求同步、刷新或排查同步时才允许调用。做安全验证或 smoke 时必须优先带 dryRun=true；只有用户明确要求真实写入时才允许 dryRun=false 或省略 dryRun。",
    "8. 不要编造不存在的装备、字段、价格、接口或数值；如果接口返回为空或字段不足，要明确说明不确定。",
    "9. 最终回答和过程说明都尽量使用中文属性名，例如把 controlSpeed 写成操控速度，把 primaryClass 写成一级分类；不要把英文属性名直接展示给普通用户。",
    "10. 如果你不确定某个字段含义，可以结合下面的固定配置字典、field-meta、database-structure 文章或常见属性字典解释。",
    "11. 工具返回里的 data.preview / uiPreview 只是给界面展示的预览，可能被裁剪；不要把 preview 裁剪说成接口数据缺失。",
    "12. 推理和最终回答必须优先读取 data.agentFacts：agentFacts.rows 是本次 HTTP 响应中完整的紧凑行；agentFacts.fields 是响应对象的紧凑字段；agentFacts.arrays 是对象内部数组。",
    "13. 只有当 agentFacts.page.hasMore 为 true 时，才说明 API 分页还有更多数据，并用 agentFacts.nextPageArgs 继续调用同一个工具补下一页。agentFacts.notes 提示 preview 被裁剪时，不需要重传同一参数。",
    "14. get_api_guns_objectId_attachments 现在会返回 slotName / accType；如果历史或异常响应只含 slotId，再用下面的枪械配件槽位字典翻译槽位名，不要再调用 get_api_object_config。",
    "",
    "ReAct 工作协议：",
    "- 你必须在 Thought -> Action -> Observation -> Thought 的循环中工作。",
    "- Thought 只输出可公开的简短思考摘要，不要输出完整隐藏推理链。",
    "- Action 只能是一个线上 OpenAPI 工具调用；不要在一轮里请求多个工具。",
    "- Observation 由系统在工具返回后写入，你需要在下一轮 Thought 中读取它。",
    "- 如果 Action 参数缺失、工具失败、HTTP 返回空或数据不足，不要停住；先把失败当作 Observation，再换参数、换工具、翻页或给出保守最终回答。",
    "- Final Answer 只能基于已有 Observation 和工具返回事实，必须说明仍不确定的部分。",
    "",
    "对话历史数据复用规则：",
    "- 对话历史中每条消息可能附带 timestamp（ISO 时间戳）和 toolCalls（调用过的工具摘要）。",
    "- 如果对话历史中已有同类问题的回答，且 timestamp 距当前时间不超过 5 分钟，则可以直接基于历史回答生成 Final Answer，不必重复调用相同工具。",
    "- 如果历史回答超过 5 分钟，或者用户明确要求刷新/重新查询，则必须调用工具获取最新数据。",
    "- 如果本次查询与历史问题相似但有新的限定条件（例如 不同配件、不同价格范围），仍然需要调用工具。",
    "- 复用历史数据时，在 Final Answer 中注明数据来自本次会话的前序查询。",
    "",
    "常见属性字典：",
    createAttributePromptGuide(),
    "",
    "固定配置字典：",
    config.objectConfigPrompt,
    "",
    "重要字段提示：",
    "- objectId / objectID 是物品 ID；不同接口大小写可能不同，调用工具时必须使用该工具参数列表里的准确参数名。",
    "- q 是通用搜索词，通常可搜索物品名、游戏名、短名和 objectId 文本。",
    "- limit / offset 是分页参数；除非用户要大量列表，先用较小 limit，例如 5 到 20。",
    "- sort / order 可用于价格、等级、射速、后坐、操控、稳定、穿透、防护等级等排序；必须使用工具参数枚举里的值。",
    "- OCR 价格 objectID 可能带 -cN 后缀，例如 11050004002-c3；物品 objectId 通常是数字。",
    "",
    "工具目录：",
    createToolCatalog(config),
    "",
    "工具选择速查：",
    "- 搜物品名或 ID：get_api_object_search 或 get_api_items。",
    "- 查枪械列表/详情/可用子弹/配件槽位/可用配件候选：get_api_guns、get_api_guns_objectId、get_api_guns_objectId_ammo、get_api_guns_objectId_attachments、get_api_guns_objectId_attachment_options。",
    "- 自动配装、按操控/稳定/后坐等目标筛配件：优先用 get_api_guns_objectId_attachment_options(objectId, scope=\"allAccessory\", includeEffects=true, limitPerSlot 取 5 到 20)，不要先分多轮查槽位、配件列表和配件详情。",
    "- 查某个具体物品的通用完整关系：get_api_items_objectId。这个接口可能返回较多关系数据，只在领域详情接口不够用时使用。",
    "- 查配件/子弹/防具/道具详情：get_api_attachments、get_api_ammo、get_api_protect、get_api_props 及对应 objectId 详情工具。",
    "- 查最新/历史价格：get_api_price_ocr_latest、get_api_price_ocr_latest_objectID、get_api_price_ocr_history、get_api_price_ocr_history_objectID、get_api_ammo_price。",
    "- 查据点材料、价格、利润、排行：get_api_places、get_api_place_materials、get_api_place_material_prices、get_api_place_profits、get_api_place_profit_ranks。",
    "- 查地图、干员、段位、集市、载具、藏品/皮肤：使用对应 get_api_game_maps、get_api_operators、get_api_rank_scores、get_api_fair_exchanges、get_api_vehicles、get_api_assets 等工具。",
    "",
    "每一轮只能返回一个 JSON 对象，禁止代码块和解释性前后缀。",
    "JSON 外层不能使用 Markdown；thought.summary 必须是可展示给用户的公开思考摘要，不要包含完整隐藏推理链。",
    "finalAnswer 字符串内容可以使用轻量 Markdown，例如 **重点**、无序列表、有序列表和简单表格。",
    "finalAnswer 如果使用 Markdown，仍必须只引用真实工具数据，并继续使用中文属性名。",
    "如果需要继续查数据，返回：",
    "{\"phase\":\"action\",\"thought\":{\"summary\":\"先把 M7 的枪械条目对准，避免把 M700 或其他近似名称混进来。\",\"hypothesis\":\"用户说的 M7 大概率是 M7 战斗步枪。\",\"evidenceGap\":\"还缺准确 objectId 和基础枪械字段。\",\"nextActionReason\":\"枪械列表能用较小 limit 快速确认命中项。\"},\"action\":{\"toolName\":\"get_api_guns\",\"args\":{\"q\":\"M7\",\"limit\":5}}}",
    "如果需要查枪械配件槽位，返回：",
    "{\"phase\":\"action\",\"thought\":{\"summary\":\"已经有了枪械 ID，下一步确认可安装槽位，判断配装空间。\",\"evidenceGap\":\"还缺槽位名称和配件类型。\",\"nextActionReason\":\"槽位接口能直接返回 slotName / accType。\"},\"action\":{\"toolName\":\"get_api_guns_objectId_attachments\",\"args\":{\"objectId\":18010000016,\"scope\":\"allAccessory\"}}}",
    "如果需要按目标配装或分析可用配件候选，返回：",
    "{\"phase\":\"action\",\"thought\":{\"summary\":\"用户目标是提升操控速度，需要直接看每个槽位候选配件和属性变化。\",\"hypothesis\":\"聚合候选接口足够支持第一版自动配装判断。\",\"nextActionReason\":\"它一次返回槽位、候选配件、数值变化和优缺点。\"},\"action\":{\"toolName\":\"get_api_guns_objectId_attachment_options\",\"args\":{\"objectId\":18010000016,\"scope\":\"allAccessory\",\"includeEffects\":true,\"limitPerSlot\":10}}}",
    "如果已经能回答，返回：",
    "{\"phase\":\"final_answer\",\"thought\":{\"summary\":\"已有观察足够支撑回答，可以把证据和不确定项一起交代清楚。\"},\"finalAnswer\":\"**推荐方案**\\n- 武器：M7 战斗步枪\\n- 选择理由：基于已查询到的操控、稳定和配件槽位数据，优先提升操控速度。\",\"confidence\":\"medium\",\"usedObjectIDs\":[18010000016]}",
  ].join("\n");
}

export function createAgentPrompt(
  input: AgentDecisionInput,
  config: DeltaforeApiConfig,
  compacted?: CompactedHistory,
): string {
  const budget = createContextBudget();
  const partition = createContextPartition(budget.availableTokens);

  const historyText = compactHistory(input.history, compacted, partition.historyBudget);
  const stepsText = input.steps.length === 0
    ? "暂无。请先形成公开 Thought，再选择与用户需求最相关的线上接口作为 Action。"
    : buildStepsText(input.steps, partition.stepsBudget);

  return [
    `用户需求：${input.query}`,
    `当前轮次：${input.round}/${input.maxRounds}`,
    `当前时间：${new Date().toISOString()}`,
    "",
    "当前线上 OpenAPI 工具摘要：",
    createCompactToolCatalog(config),
    "",
    "工具结果读取规则：",
    "- 优先读每条结果的 data.agentFacts，不要用 data.preview 判断数据是否完整。",
    "- data.preview/uiPreview 只是 UI 预览；它被裁剪时，不代表 HTTP 接口只返回了这些数据。",
    "- 如果 data.agentFacts.page.hasMore=true，再用 data.agentFacts.nextPageArgs 继续查下一页。",
    "- 如果 data.agentFacts.rows 已包含所需行，就直接基于这些行回答，不要重复调用同一个工具。",
    "",
    "对话历史：",
    historyText,
    "",
    "ReAct 历史轨迹：",
    stepsText,
    "",
    "请按 ReAct 协议决定下一步：输出公开 Thought + 一个 Action，或输出公开 Thought + Final Answer。",
  ].join("\n");
}

function buildStepsText(steps: ReactStep[], budgetTokens: number): string {
  const fullText = JSON.stringify(createReactMemory(steps), null, 2);
  const fullTokens = estimateTokens(fullText);

  if (fullTokens <= budgetTokens) return fullText;

  return compactSteps(steps, budgetTokens);
}

function createReactMemory(steps: ReactStep[]): unknown[] {
  return steps.map((step) => ({
    round: step.round,
    status: step.status,
    thought: step.thought,
    action: step.action,
    observation: step.observation,
    toolResult: step.toolResult === undefined ? undefined : createAgentToolMemory([step.toolResult])[0],
  }));
}

function createAgentToolMemory(toolResults: AgentToolResult[]): unknown[] {
  return toolResults.map((result) => {
    const data = isRecord(result.data)
      ? createPromptHttpData(result.data)
      : result.data;

    return {
      toolName: result.toolName,
      args: result.args,
      ok: result.ok,
      summary: result.summary,
      data,
    };
  });
}

function createPromptHttpData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    status: data.status,
    statusText: data.statusText,
    method: data.method,
    path: data.path,
    params: data.params,
    responseSummary: data.responseSummary,
    agentFacts: data.path === "/api/guns/{objectId}/attachment-options"
      ? createAttachmentOptionsPromptFacts(data.agentFacts)
      : data.agentFacts,
  };
}

function createAttachmentOptionsPromptFacts(agentFacts: unknown): unknown {
  if (!isRecord(agentFacts)) {
    return agentFacts;
  }

  const rows = Array.isArray(agentFacts.rows) ? agentFacts.rows.filter(isRecord) : [];
  const globalOptions = selectGlobalAttachmentOptions(rows, 18);

  return {
    kind: agentFacts.kind,
    complete: agentFacts.complete,
    truncated: agentFacts.truncated,
    rowsKey: agentFacts.rowsKey,
    rowCount: agentFacts.rowCount,
    fields: agentFacts.fields,
    rows: rows.map((slot) => ({
      slotId: slot.slotId,
      slotName: slot.slotName,
      accType: slot.accType,
      optionCount: slot.optionCount,
      bestOptions: selectSlotAttachmentOptions(slot).map((option) => createPromptAttachmentOption(option, slot)),
    })),
    topControlOptions: globalOptions.map(({ option, slot }) => createPromptAttachmentOption(option, slot)),
    notes: [
      "This is a compact ReAct memory view of attachment-options.",
      "Use rows[].bestOptions and topControlOptions for loadout reasoning.",
    ],
  };
}

function selectSlotAttachmentOptions(slot: Record<string, unknown>): Array<Record<string, unknown>> {
  const options = Array.isArray(slot.options) ? slot.options.filter(isRecord) : [];
  const selected: Record<string, unknown>[] = [];
  const add = (items: Array<Record<string, unknown>>) => {
    for (const item of items) {
      const id = readOptionId(item);
      if (!selected.some((existing) => readOptionId(existing) === id)) {
        selected.push(item);
      }
    }
  };

  add(sortOptionsByStat(options, "control_speed").slice(0, 2));
  add(sortOptionsByStat(options, "recoil").filter((option) => readAttachmentNumber(option, "recoil") > 0).slice(0, 1));
  add(sortOptionsByStat(options, "control_stable").filter((option) => readAttachmentNumber(option, "control_stable") > 0).slice(0, 1));

  return selected.slice(0, 4);
}

function selectGlobalAttachmentOptions(
  slots: Array<Record<string, unknown>>,
  limit: number,
): Array<{ option: Record<string, unknown>; slot: Record<string, unknown> }> {
  return slots
    .flatMap((slot) => {
      const options = Array.isArray(slot.options) ? slot.options.filter(isRecord) : [];
      return options.map((option) => ({ option, slot }));
    })
    .sort((left, right) => readAttachmentNumber(right.option, "control_speed") - readAttachmentNumber(left.option, "control_speed"))
    .slice(0, limit);
}

function sortOptionsByStat(options: Array<Record<string, unknown>>, stat: string): Array<Record<string, unknown>> {
  return [...options].sort((left, right) => readAttachmentNumber(right, stat) - readAttachmentNumber(left, stat));
}

function createPromptAttachmentOption(
  option: Record<string, unknown>,
  slot: Record<string, unknown>,
): Record<string, unknown> {
  const attachment = isRecord(option.attachment) ? option.attachment : {};
  const effects = Array.isArray(option.effects) ? option.effects.filter(isRecord) : [];

  return {
    slotId: slot.slotId,
    slotName: slot.slotName,
    objectId: option.objectId,
    objectName: option.objectName,
    avgPrice: option.avgPrice,
    controlSpeed: attachment.control_speed,
    recoilControl: attachment.recoil,
    stability: attachment.control_stable,
    hipFire: attachment.hip_shot,
    rangePercent: attachment.shot_distance_percent,
    effects: effects
      .map((effect) => effect.valueText)
      .filter((text): text is string => typeof text === "string")
      .slice(0, 4),
  };
}

function readAttachmentNumber(option: Record<string, unknown>, stat: string): number {
  const attachment = isRecord(option.attachment) ? option.attachment : {};
  const value = attachment[stat];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function readOptionId(option: Record<string, unknown>): unknown {
  return option.objectId ?? option.objectName;
}
