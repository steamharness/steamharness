import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryPanel } from "../panel";
import { memoryText, createMemoryClient } from "../index";
const item = {
  id: "one",
  scope: "global",
  content: "完整的中文记忆\n第二行",
  origin: "manual",
  version: 3,
  updatedAt: "2026-10-01T00:00:00Z",
  sources: [{ id: "source", role: "user", content: "用户原始片段" }],
};
const caps = {
  connected: true,
  enabled: true,
  status: "ready",
  automatic: true,
  readOnly: false,
};
const panels: ReturnType<typeof createMemoryPanel>[] = [];
afterEach(() => {
  panels.splice(0).forEach((panel) => panel.dispose());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function mount(
  call: (action: string, input?: Record<string, unknown>) => Promise<any>,
  account = false,
) {
  const panel = createMemoryPanel({
    client: { call },
    locale: "zh-CN",
    account,
  });
  panels.push(panel);
  document.body.append(panel.element);
  return { panel, ui: within(panel.element) };
}
test("full detail is fetched, sources stay inert, and manual edits carry the current version", async () => {
  const calls: any[] = [];
  const { ui } = mount(async (action, input) => {
    calls.push({ action, input });
    if (action === "capabilities") return caps;
    if (action === "list") return { items: [item] };
    if (action === "get") return item;
    return {};
  });
  fireEvent.click(await ui.findByRole("button", { name: /完整的中文记忆/ }));
  await ui.findByText("用户原始片段");
  expect(ui.getByRole("article").textContent).toContain(item.content);
  fireEvent.click(ui.getByRole("button", { name: "编辑" }));
  fireEvent.input(ui.getByRole("textbox", { name: "记忆内容" }), {
    target: { value: "编辑后的记忆" },
  });
  fireEvent.click(ui.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.action === "update" &&
          call.input.version === 3 &&
          call.input.content === "编辑后的记忆",
      ),
    ).toBe(true),
  );
  expect(
    calls.find((call) => call.action === "update").input.operationId,
  ).toBeTruthy();
});
test("read-only panels offer reading and hide editing actions", async () => {
  const { ui } = mount(async (action) =>
    action === "capabilities"
      ? { ...caps, readOnly: true }
      : action === "get"
        ? item
        : { items: [item] },
  );
  fireEvent.click(await ui.findByRole("button", { name: /完整的中文记忆/ }));
  await ui.findByText("用户原始片段");
  expect(ui.queryByRole("button", { name: "编辑" })).toBeNull();
  expect(ui.queryByRole("button", { name: "遗忘" })).toBeNull();
  expect(ui.getByRole("button", { name: "记住" })).toBeDisabled();
});
test("disposed account panels drop in-flight private content and errors", async () => {
  let finish!: (data: any) => void;
  const { panel } = mount(async (action) =>
    action === "capabilities"
      ? caps
      : new Promise((resolve) => (finish = resolve)),
  );
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  panel.dispose();
  finish({ items: [item] });
  await Promise.resolve();
  await Promise.resolve();
  expect(panel.element.textContent).toBe("");
});
test("service errors differ from empty data and stale pagination is disabled", async () => {
  let failure = false;
  const { ui } = mount(async (action) => {
    if (action === "capabilities") {
      if (failure) throw new Error("offline");
      return caps;
    }
    return { items: [item], nextCursor: "next" };
  });
  await ui.findByRole("button", { name: /完整的中文记忆/ });
  expect(ui.getByRole("button", { name: "下一页" })).not.toBeDisabled();
  failure = true;
  fireEvent.click(ui.getByRole("button", { name: "刷新" }));
  await ui.findByText(memoryText("zh", "error"));
  expect(ui.getByRole("button", { name: "下一页" })).toBeDisabled();
  expect(ui.queryByText("暂无记忆")).toBeNull();
});
test("management client encodes IDs and keeps credentials in its host adapter", async () => {
  const request = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ errCode: 0, data: { ok: true } })),
  );
  await createMemoryClient({
    baseUrl: "https://server.test",
    fetch: request,
  }).call("update", { id: "a/b", version: 1, content: "text" });
  expect(String(request.mock.calls[0]?.[0])).toBe(
    "https://server.test/api/me/memories/a%2Fb",
  );
  expect(memoryText("fr", "edit")).toBe("Edit");
  expect(memoryText("zh-cn", "edit")).toBe("编辑");
});
