import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryPanel } from "../panel";
import { memoryText, memoryJobText, createMemoryClient } from "../index";
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
  onAuthorize?: () => void,
) {
  const panel = createMemoryPanel({
    client: { call },
    locale: "zh-CN",
    account,
    onAuthorize,
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
test("account switches have accessible labels, save preferences and restore them after failure", async () => {
  let preferences = { enabled: true, automatic: true };
  let fail = false;
  const changes: any[] = [];
  const { ui } = mount(async (action, input) => {
    if (action === "capabilities") return { ...caps, enabled: preferences.enabled };
    if (action === "preferences") return preferences;
    if (action === "scopes" || action === "jobs") return [];
    if (action === "setPreferences") {
      changes.push(input);
      if (fail) throw new Error("offline");
      return (preferences = input as typeof preferences);
    }
    return { items: [] };
  }, true);
  const enabled = await ui.findByRole("switch", { name: "账号记忆" });
  const automatic = ui.getByRole("switch", { name: "自动保存长期记忆" });
  await waitFor(() => expect(enabled).toBeEnabled());
  expect(enabled).toBeChecked();
  expect(automatic).toBeChecked();
  fireEvent.click(enabled);
  await waitFor(() => expect(enabled).toBeEnabled());
  expect(changes).toEqual([{ enabled: false, automatic: true }]);
  expect(automatic).toBeDisabled();
  fail = true;
  fireEvent.click(enabled);
  await ui.findByText(memoryText("zh", "error"));
  expect(enabled).not.toBeChecked();
  expect(automatic).toBeChecked();
  expect(automatic).toBeDisabled();
});
test("revoked-login jobs explain the interruption and retry with the current host without duplicate clicks", async () => {
  let finish!: () => void;
  let status = "failed";
  const call = vi.fn(async (action: string, input?: Record<string, unknown>) => {
    if (action === "capabilities") return caps;
    if (action === "preferences") return { enabled: true, automatic: true };
    if (action === "scopes") return [];
    if (action === "jobs") return [{ id: "old-login-turn", status, reason: "authorization_changed", retryable: true }];
    if (action === "retry") {
      expect(input).toEqual({ id: "old-login-turn" });
      await new Promise<void>(resolve => finish = resolve);
      status = "pending";
      return {};
    }
    return { items: [] };
  });
  const { ui } = mount(call, true);
  await ui.findByText("记忆保存已暂停");
  expect(ui.getByText(memoryText("zh", "authorizationChanged"))).toBeVisible();
  expect(ui.queryByText("提炼失败")).toBeNull();
  const retry = ui.getByRole("button", { name: "重新提炼" });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  expect(retry).toBeDisabled();
  expect(retry).toHaveTextContent("正在重试…");
  fireEvent.click(retry);
  expect(call.mock.calls.filter(args => args[0] === "retry")).toHaveLength(1);
  finish();
  await ui.findByText("待提炼");
});
test.each(["scope_locked", "automatic_disabled"])("%s jobs retain their reason and cannot retry", async reason => {
  const { ui } = mount(async action => {
    if (action === "capabilities") return caps;
    if (action === "preferences") return { enabled: true, automatic: true };
    if (action === "scopes") return [];
    if (action === "jobs") return [{ id: "blocked", status: "failed", reason, retryable: false }];
    return { items: [] };
  }, true);
  const text = memoryJobText({ status: "failed", reason });
  await ui.findByText(memoryText("zh", text.detail!));
  expect(ui.getByRole("button", { name: "重新提炼" })).toBeDisabled();
});
test("retry errors preserve the edit draft and distinguish a rejected retry from an edit conflict", async () => {
  const { ui } = mount(async action => {
    if (action === "capabilities") return caps;
    if (action === "preferences") return { enabled: true, automatic: true };
    if (action === "scopes") return [];
    if (action === "jobs") return [{ id: "failed", status: "failed", reason: "extraction_failed", retryable: true }];
    if (action === "get") return item;
    if (action === "retry") throw Object.assign(new Error("Automatic memory is disabled."), { status: 409 });
    return { items: [item] };
  }, true);
  fireEvent.click(await ui.findByRole("button", { name: /完整的中文记忆/ }));
  fireEvent.click(await ui.findByRole("button", { name: "编辑" }));
  const draft = ui.getByRole("textbox", { name: "记忆内容" });
  fireEvent.input(draft, { target: { value: "尚未保存的草稿" } });
  fireEvent.click(ui.getByRole("button", { name: "重新提炼" }));
  await ui.findByText(memoryText("zh", "retryError"));
  expect(draft).toHaveValue("尚未保存的草稿");
  expect(ui.queryByText(memoryText("zh", "conflict"))).toBeNull();
  await waitFor(() => expect(ui.getByRole("button", { name: "重新提炼" })).toBeEnabled());
});
test("job reasons have English fallbacks and distinguish running from queued extraction", () => {
  for (const reason of ["authorization_changed", "automatic_disabled", "scope_locked", "extraction_interrupted", "unknown"]) {
    const text = memoryJobText({ status: "failed", reason });
    expect(memoryText("fr", text.label)).toMatch(/paused|failed/);
    expect(memoryText("fr", text.detail!)).toBeTruthy();
    expect(memoryText("zh-CN", text.detail!)).not.toBe(memoryText("en", text.detail!));
  }
  expect(memoryJobText({ status: "running" }).label).toBe("extracting");
  expect(memoryJobText({ status: "pending" }).label).toBe("pending");
});
test("unconfigured service does not ask for sign-in or request unavailable records", async () => {
  const actions: string[] = [];
  const { ui, panel } = mount(async (action) => {
    actions.push(action);
    if (action === "capabilities")
      return { ...caps, connected: false, status: "unconfigured" };
    throw new Error("Service not configured");
  }, true);
  await ui.findByText(memoryText("zh", "unconfigured"));
  expect(actions).toEqual(["capabilities"]);
  expect(panel.element.textContent).not.toMatch(/登录|sign in/i);
  expect(panel.element.querySelector<HTMLElement>(".am-layout")?.hidden).toBe(true);
  expect(ui.getByRole("switch", { name: "账号记忆" })).toBeDisabled();
  expect(ui.getByRole("button", { name: "记住" })).toBeDisabled();
});
test("authorization errors offer host verification without conflating service configuration", async () => {
  const authorize = vi.fn();
  const { ui } = mount(async () => {
    throw Object.assign(new Error("No account credential"), { status: 401 });
  }, true, authorize);
  fireEvent.click(await ui.findByRole("button", { name: "验证账号授权" }));
  expect(authorize).toHaveBeenCalledOnce();
  expect(ui.queryByText(memoryText("zh", "unconfigured"))).toBeNull();
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
  expect(ui.getByRole("button", { name: "下一页", hidden: true })).toBeDisabled();
  expect(ui.getByRole("button", { name: "记住" })).toBeDisabled();
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
test("unsupported servers retain HTTP status even when they return HTML", async () => {
  const request = vi.fn(async () => new Response("<html>Not found</html>", { status: 404 }));
  await expect(createMemoryClient({ baseUrl: "https://server.test", fetch: request }).call("capabilities"))
    .rejects.toMatchObject({ status: 404 });
});
test("canceling a manual memory returns to the empty list", async () => {
  const { ui, panel } = mount(async (action) => action === "capabilities" ? caps : { items: [] });
  await ui.findByText("暂无记忆");
  fireEvent.click(ui.getByRole("button", { name: "记住" }));
  expect(panel.element).toHaveClass("am-show-detail");
  fireEvent.click(ui.getByRole("button", { name: "取消" }));
  expect(panel.element).not.toHaveClass("am-show-detail");
});
