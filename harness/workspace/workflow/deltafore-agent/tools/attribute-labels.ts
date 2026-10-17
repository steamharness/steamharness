export interface AttributeLabel {
  attribute: string;
  label: string;
  description: string;
}

const ATTRIBUTE_LABELS: AttributeLabel[] = [
  {
    attribute: "primaryClass",
    label: "一级分类",
    description: "装备顶层类型，例如枪械、配件、防具、药品、弹药等；用于先判断装备属于哪一大类。",
  },
  {
    attribute: "secondClass",
    label: "二级分类",
    description: "一级分类下的细分类型代码，例如配件下的枪管、弹匣、枪托等；优先结合 secondClassCN 解读。",
  },
  {
    attribute: "secondClassCN",
    label: "二级分类中文名",
    description: "secondClass 对应的中文展示名，例如枪管、弹匣、护木、防弹衣、头盔等。",
  },
  {
    attribute: "thirdClass",
    label: "三级分类",
    description: "更细的分类代码，部分装备才有；用于继续区分更具体的装备槽位或类型。",
  },
  {
    attribute: "thirdClassCN",
    label: "三级分类中文名",
    description: "thirdClass 对应的中文展示名，存在时优先展示中文。",
  },
  {
    attribute: "objectID",
    label: "装备 ID",
    description: "装备唯一标识，用于 getItemDetail 精确查询。",
  },
  {
    attribute: "objectName",
    label: "装备名称",
    description: "装备正式名称，回答中应优先展示这个中文名称。",
  },
  {
    attribute: "shortName",
    label: "短名称",
    description: "装备短名或简称，可用于搜索和快速识别。",
  },
  {
    attribute: "grade",
    label: "等级",
    description: "装备品质或等级，通常数字越高代表品级更高。",
  },
  {
    attribute: "avgPrice",
    label: "均价",
    description: "市场平均价格，可用于判断性价比或预算压力。",
  },
  {
    attribute: "controlSpeed",
    label: "操控速度",
    description: "影响开镜、举枪、切换或操作手感的速度；配件中为负数通常代表拖慢操控，为正数通常代表提升操控。",
  },
  {
    attribute: "controlStable",
    label: "据枪稳定性",
    description: "影响据枪时的稳定表现，数值越高通常越利于持续瞄准。",
  },
  {
    attribute: "control",
    label: "后坐力控制",
    description: "枪械控制属性，影响压枪和连续射击可控性。",
  },
  {
    attribute: "stable",
    label: "稳定性",
    description: "枪械稳定属性，影响瞄准稳定和晃动控制。",
  },
  {
    attribute: "hipShot",
    label: "腰际射击精度",
    description: "影响不开镜或腰射时的命中表现。",
  },
  {
    attribute: "recoil",
    label: "后坐力",
    description: "影响射击后枪口跳动和回正压力；需要结合字段语境判断正负增益。",
  },
  {
    attribute: "fireSpeed",
    label: "射速",
    description: "单位时间内射击速度，影响近距离爆发和弹药消耗。",
  },
  {
    attribute: "capacity",
    label: "容量",
    description: "弹匣、背包、防具或容器容量，需结合装备类型理解。",
  },
  {
    attribute: "bombCapacity",
    label: "弹匣容量",
    description: "弹匣可容纳子弹数量，影响续航和换弹频率。",
  },
  {
    attribute: "shotDistancePercent",
    label: "有效射程加成",
    description: "有效射程或枪口初速的百分比提升，常见于枪管类配件。",
  },
  {
    attribute: "caliber",
    label: "口径",
    description: "武器使用的弹药口径，用于匹配弹药。",
  },
  {
    attribute: "muzzleVelocity",
    label: "枪口初速",
    description: "子弹初速，通常影响远距离弹道和命中体验。",
  },
  {
    attribute: "shootDistance",
    label: "有效射程",
    description: "武器有效作战距离，影响中远距离表现。",
  },
  {
    attribute: "protectLevel",
    label: "防护等级",
    description: "护甲或头盔的防护级别，通常越高越能抵挡高等级弹药。",
  },
  {
    attribute: "durability",
    label: "耐久",
    description: "防具或道具可承受消耗的耐久值。",
  },
  {
    attribute: "durableLoss",
    label: "耐久损耗",
    description: "受到攻击或使用时的耐久损耗倾向。",
  },
  {
    attribute: "protectArea",
    label: "防护区域",
    description: "防具覆盖身体部位或头盔覆盖区域。",
  },
  {
    attribute: "repairEfficiency",
    label: "修复效率",
    description: "维修或恢复效果效率，数值越高通常代表修复更有效。",
  },
  {
    attribute: "aimSpeed",
    label: "瞄准速度",
    description: "防具等装备对开镜或瞄准速度的影响。",
  },
  {
    attribute: "moveSpeed",
    label: "移动速度",
    description: "装备对角色移动速度的影响。",
  },
  {
    attribute: "soundEffect",
    label: "声音影响",
    description: "装备对听声、脚步或声音传播的影响。",
  },
  {
    attribute: "repairPoints",
    label: "修复点数",
    description: "药品或维修类道具提供的修复量。",
  },
  {
    attribute: "repairArea",
    label: "修复部位",
    description: "药品或维修类道具可作用的身体部位或装备区域。",
  },
  {
    attribute: "activeTime",
    label: "生效时间",
    description: "道具效果持续或完成所需时间。",
  },
  {
    attribute: "availableCount",
    label: "可用次数",
    description: "道具可使用次数。",
  },
  {
    attribute: "penetrationLevel",
    label: "穿透等级",
    description: "弹药穿透能力等级，用于判断能否有效击穿防护。",
  },
  {
    attribute: "armorHarmLevel",
    label: "甲伤等级",
    description: "弹药对护甲造成伤害的等级或能力。",
  },
  {
    attribute: "harmRatio",
    label: "伤害倍率",
    description: "弹药伤害倍率或伤害系数。",
  },
];

const ATTRIBUTE_LABEL_MAP = new Map(ATTRIBUTE_LABELS.map((entry) => [normalizeAttributeName(entry.attribute), entry]));

export function lookupAttributeLabels(attributes: string[]): AttributeLabel[] {
  const result: AttributeLabel[] = [];
  const seen = new Set<string>();

  for (const attribute of attributes) {
    const normalized = normalizeAttributeName(attribute);
    const entry = ATTRIBUTE_LABEL_MAP.get(normalized);
    if (entry !== undefined && !seen.has(entry.attribute)) {
      result.push(entry);
      seen.add(entry.attribute);
    }
  }

  return result;
}

export function formatAttributeLabel(attribute: string): string {
  const entry = ATTRIBUTE_LABEL_MAP.get(normalizeAttributeName(attribute));
  return entry?.label ?? attribute;
}

export function createAttributePromptGuide(): string {
  return ATTRIBUTE_LABELS.map((entry) => `- ${entry.attribute} = ${entry.label}：${entry.description}`).join("\n");
}

function normalizeAttributeName(value: string): string {
  const parts = value.split(".");
  return (parts[parts.length - 1] ?? value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s"'`_·•。！？!?，,、；;：:/|\\()[\]{}<>《》【】\-–—]+/g, "");
}
