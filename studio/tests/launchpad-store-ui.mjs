export function storeFixture(zh) {
  const t = (en, cn) => (zh ? cn : en);
  const checklist = {
    id: "checklist",
    name: t("Release checklist", "发布检查清单"),
    projectType: "workflow",
    version: "0.1.0",
    summary: t(
      "Turn release tasks into a Markdown checklist.",
      "将发布事项整理成一份可逐项核对的 Markdown 清单。",
    ),
    description: t(
      "Enter one task per line. The workflow groups your tasks into a **Markdown checklist** for the release review.\n\n## Usage\n\n1. Open the workflow entry.\n2. Add the tasks and run the workflow.\n3. Review the output before publishing.",
      "每行输入一项发布事项。工作流会把这些事项整理成一份 **Markdown 检查清单**，供发布前核对。\n\n## 使用方法\n\n1. 打开工作流入口。\n2. 逐行输入本次发布事项并运行。\n3. 在结果中逐项检查，确认后再发布。",
    ),
    entryTypes: ["workflow"],
    projectEntries: [
      {
        name: t("Generate checklist", "生成检查清单"),
        type: "workflow",
        primary: true,
      },
    ],
    updatedAt: "2026-11-18T05:00:00Z",
    images: ["/store-preview/workflow-result.png", "/store-preview/start.png"],
  };
  const items = [
    {
      id: "notes",
      name: t("Notes assistant", "笔记助手"),
      projectType: "bot",
      version: "1.0.0",
      description: "**Notes**",
    },
    {
      id: "board",
      name: t("Task board", "任务看板"),
      projectType: "kanban",
      version: "1.1.0",
      description: "",
      images: [],
    },
    checklist,
  ];
  return {
    items,
    recommendations: [checklist, items[1]].map(({ id, name, summary }) => ({
      id,
      name,
      description: summary,
    })),
  };
}

import assert from "node:assert/strict";

export async function checkStoreExperience({ page, t }) {
  const tab = page.locator("#lp-tab-store"),
    home = page.locator(".studio-launchpad");
  const before = () =>
    page.evaluate(
      () => window.actions.filter(([id]) => id === "studio.openStore").length,
    );
  const count = await before();
  await tab.click();
  assert.equal(
    await before(),
    count + 1,
    "the Store tab opens the shared Store surface",
  );
  assert.equal(
    await tab.getAttribute("aria-selected"),
    "false",
    "the shared Store opens without switching the native catalog tab",
  );
  assert.equal(
    await home.locator("#lp-page-store").isVisible(),
    false,
    "the native Store page remains a fallback, not the primary surface",
  );
  const labels = await tab.textContent();
  assert.ok(labels?.includes(t("Store", "商店")));
}
