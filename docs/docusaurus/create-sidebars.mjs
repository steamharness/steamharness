import { readFileSync } from "node:fs";

const docsConfig = JSON.parse(
  readFileSync(new URL("../docs.json", import.meta.url), "utf8"),
);

export function createSidebars(language) {
  const navigation = docsConfig.navigation.languages.find(
    (entry) => entry.language === language,
  );
  if (!navigation) throw new Error(`Missing ${language} navigation in docs.json.`);

  const [guides, reference, releases] = navigation.tabs;
  const normalizeId = (page) => language === "en" ? page.replace(/^en\//u, "") : page;
  // 导航项可以是页面 id，也可以是 `{ label, path, items }` 形式的嵌套分类。
  // 发布日志按单元分组：一个单元上百条，摊平成一长串没法用。
  const normalizeItem = (item) => typeof item === "string"
    ? normalizeId(item)
    : {
      type: "category",
      label: item.label,
      collapsed: true,
      link: { type: "doc", id: normalizeId(item.path) },
      items: item.items.map(normalizeId),
    };
  const groups = (tab) => tab.groups.map((group) => ({
    type: "category",
    label: group.group,
    collapsed: false,
    items: group.pages.map(normalizeItem),
  }));

  return {
    guidesSidebar: groups(guides),
    referenceSidebar: groups(reference),
    releasesSidebar: groups(releases),
  };
}
