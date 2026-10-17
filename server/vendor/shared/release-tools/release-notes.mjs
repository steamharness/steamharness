/**
 * 发布日志（`CHANGELOG.next*` → `CHANGELOG*`）的格式校验。
 *
 * 日志按 earendil-works/pi 的六段式组织：`新特性` 是只放最值得用户知道的两三条的精选层，
 * 完整层用 `新增 / 变更 / 修复 / 移除` 覆盖全部变更，不兼容改动单列 `破坏性变更` 并保留迁移说明。
 * section 顺序固定，缺项允许，重复或乱序会被拒绝。
 *
 * 这份逻辑在 core / cli / server / 三个内置项目里各有一份调用方。任何一份漂移都会让某个仓库的
 * 发版门禁比别的仓库弱，而那种差异在 review 里几乎看不出来，所以真相源只放在这里，
 * 其余仓库通过 `vendor/shared/release-tools/` 快照或 `check-builtin-copies.mjs` 副本使用。
 */

/** 六段式的唯一定义。`shape` 决定条目写法，`migration` 决定是否允许缩进迁移行。 */
export const RELEASE_NOTE_SECTIONS = Object.freeze([
  { id: "features", zh: "新特性", en: "New Features", shape: "headline", migration: false },
  { id: "breaking", zh: "破坏性变更", en: "Breaking Changes", shape: "plain", migration: true },
  { id: "added", zh: "新增", en: "Added", shape: "verb", zhPrefix: "新增", enPrefix: "Added", migration: false },
  { id: "changed", zh: "变更", en: "Changed", shape: "verb", zhPrefix: "变更", enPrefix: "Changed", migration: false },
  { id: "fixed", zh: "修复", en: "Fixed", shape: "verb", zhPrefix: "修复", enPrefix: "Fixed", migration: false },
  { id: "removed", zh: "移除", en: "Removed", shape: "verb", zhPrefix: "移除", enPrefix: "Removed", migration: false },
]);

/**
 * 条目正文上限：中文 100 字约等于编辑器里两行，英文放宽到 180 以容纳同义句式。
 * 旧版条目普遍 200–400 字，把「改了什么」「怎么定位的」「怎么迁移」全塞在一行，正是没人读的原因。
 */
export const MAX_ENTRY_LENGTH = Object.freeze({ "zh-CN": 100, en: 180 });

const MIGRATION_PREFIX = Object.freeze({ "zh-CN": "迁移：", en: "Migration: " });

/** 尾部 Docs 链接是元数据不是正文，不计入长度预算。 */
function measureProse(text) {
  return text.replace(/(参见|See)\s*\[[^\]]*\]\([^)]*\)[。.]?\s*$/u, "").trim();
}

/**
 * 解析并校验一个 `CHANGELOG.next*` 文件。
 * @returns {{ body: string, outline: Array<{ id: string, count: number }> }}
 */
export function parseNext(contents, locale) {
  const normalized = contents.replace(/\r\n?/g, "\n");
  const [heading, ...lines] = normalized.split("\n");
  if (heading !== "# Unreleased") {
    throw new Error(`${locale} CHANGELOG.next must start with '# Unreleased'.`);
  }
  // 空行要保留：section 之间和条目之间的留白正是可读性的一部分，归档时原样带进 CHANGELOG.md。
  const body = lines.join("\n").trim();
  if (body === "") {
    throw new Error(`${locale} CHANGELOG.next has no release notes.`);
  }

  const limit = MAX_ENTRY_LENGTH[locale];
  const outline = [];
  let current = null;
  let lastWasEntry = false;

  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const sectionHeading = /^###\s+(\S.*?)\s*$/.exec(line);
    if (sectionHeading) {
      current = openSection(sectionHeading[1], locale, outline);
      lastWasEntry = false;
      continue;
    }
    if (!current) {
      throw new Error(`${locale} release notes must open with a '### ' section heading, got: ${line}`);
    }
    if (line.startsWith("  ") && line.trimStart().startsWith(MIGRATION_PREFIX[locale])) {
      if (!current.definition.migration || !lastWasEntry) {
        throw new Error(`${locale} migration note must follow an entry inside '${current.name}': ${line.trim()}`);
      }
      lastWasEntry = false;
      continue;
    }
    if (/^(【.+】|\[[^\]]+\])/u.test(line.slice(2))) {
      throw new Error(
        `${locale} release note still uses the retired bracket tag format: ${line}\n`
        + `Group entries under '### ' section headings and prefix each line with a bare verb instead, for example:\n`
        + `  ### ${RELEASE_NOTE_SECTIONS[2].zh}\n  - ${RELEASE_NOTE_SECTIONS[2].zhPrefix} <一句话说明>`,
      );
    }
    const text = readEntryText(current.definition, line, locale);
    if (text === null) {
      throw new Error(`${locale} release note has invalid format: ${line}`);
    }
    const length = measureProse(text).length;
    if (length > limit) {
      throw new Error(
        `${locale} release note exceeds the ${limit} character limit (${length}): ${line}\n`
        + `Keep the outcome in the entry and move details to docs/ or the pull request.`,
      );
    }
    current.count += 1;
    lastWasEntry = true;
  }

  for (const section of outline) {
    if (section.count === 0) {
      throw new Error(`${locale} release notes section '${section.name}' has no entries.`);
    }
  }

  return { body, outline: outline.map(({ id, count }) => ({ id, count })) };
}

function openSection(name, locale, outline) {
  const definition = RELEASE_NOTE_SECTIONS.find((section) => localizedName(section, locale) === name);
  if (!definition) {
    const allowed = RELEASE_NOTE_SECTIONS.map((section) => localizedName(section, locale)).join(", ");
    throw new Error(`${locale} release notes use unknown section '${name}'. Expected one of: ${allowed}.`);
  }
  if (outline.some((section) => section.id === definition.id)) {
    throw new Error(`${locale} release notes repeat section '${name}'.`);
  }
  const previous = outline[outline.length - 1];
  if (previous && RELEASE_NOTE_SECTIONS.findIndex((section) => section.id === previous.id)
    >= RELEASE_NOTE_SECTIONS.findIndex((section) => section.id === definition.id)) {
    throw new Error(`${locale} release notes list section '${name}' out of order.`);
  }
  const section = { id: definition.id, name, definition, count: 0 };
  outline.push(section);
  return section;
}

/** 返回去掉列表符与动词前缀后的正文；写法不符返回 null。 */
function readEntryText(section, line, locale) {
  if (!line.startsWith("- ")) return null;
  const text = line.slice(2);
  if (section.shape === "headline") {
    const pattern = locale === "zh-CN" ? /^\*\*([^*]+)\*\*：(.+)$/ : /^\*\*([^*]+)\*\*: (.+)$/;
    return pattern.test(text) ? text : null;
  }
  if (section.shape === "verb") {
    const prefix = locale === "zh-CN" ? section.zhPrefix : section.enPrefix;
    return text.startsWith(`${prefix} `) ? text : null;
  }
  return text.trim() === "" ? null : text;
}

function localizedName(section, locale) {
  return locale === "zh-CN" ? section.zh : section.en;
}

/** 中英两侧必须逐 section、逐条目数对齐，否则译文和原文说的不是同一件事。 */
export function assertNextParity(zhNext, enNext) {
  if (JSON.stringify(zhNext.outline) !== JSON.stringify(enNext.outline)) {
    throw new Error("Chinese and English release notes must have matching sections, entry counts and order.");
  }
}

/**
 * 历史日志只比对结构，不校验条目写法：改造前的扁平历史不该因为缺少 section 标题而无法归档。
 * 但版本/日期与逐版本条目数必须中英一致，否则译文会悄悄落后。
 */
export function assertHistoryParity(zhHistory, enHistory) {
  if (JSON.stringify(readHistoryVersions(zhHistory)) !== JSON.stringify(readHistoryVersions(enHistory))) {
    throw new Error("Chinese and English changelog histories must have matching versions and dates.");
  }
  if (JSON.stringify(readHistoryOutline(zhHistory, "zh-CN")) !== JSON.stringify(readHistoryOutline(enHistory, "en"))) {
    throw new Error("Chinese and English changelog histories must have matching sections and entry counts per version.");
  }
}

export function readHistoryVersions(contents) {
  return [...contents.replace(/\r\n?/g, "\n").matchAll(/^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$/gm)]
    .map((match) => ({ version: match[1], date: match[2] }));
}

function readHistoryOutline(contents, locale) {
  const normalized = contents.replace(/\r\n?/g, "\n");
  const marks = [...normalized.matchAll(/^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$/gm)];
  return marks.map((mark, index) => readBlockOutline(
    normalized.slice(mark.index + mark[0].length, marks[index + 1]?.index ?? normalized.length),
    locale,
  ));
}

function readBlockOutline(block, locale) {
  const outline = [];
  let current = null;
  for (const line of block.split("\n")) {
    if (line.trim() === "") continue;
    const sectionHeading = /^###\s+(\S.*?)\s*$/.exec(line);
    if (sectionHeading) {
      const definition = RELEASE_NOTE_SECTIONS.find((section) => localizedName(section, locale) === sectionHeading[1]);
      current = { id: definition?.id ?? `unknown:${sectionHeading[1]}`, count: 0 };
      outline.push(current);
      continue;
    }
    if (line.startsWith("- ")) {
      // 改造前的历史是扁平格式，两侧同样落进 legacy 桶即可保持可比，不会因为缺少 section 而误报。
      if (!current) {
        current = { id: "legacy", count: 0 };
        outline.push(current);
      }
      current.count += 1;
    }
  }
  return outline;
}

export function appendHistory(history, version, date, body) {
  return `${history.trimEnd()}\n\n## ${version} - ${date}\n\n${body}\n`;
}
