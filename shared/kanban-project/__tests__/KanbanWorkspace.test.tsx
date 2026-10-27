import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KanbanWorkspace, type KanbanWorkspaceProps } from "../KanbanWorkspace";
import { KanbanPreviewFrame } from "../KanbanPreviewFrame";
import { KANBAN_PRESENTATION_MESSAGE } from "../index";

afterEach(() => {
  vi.useRealTimers();
});

describe("KanbanWorkspace", () => {
  it("updates presentation without remounting and resends the latest mode after loading or readiness", () => {
    const props = createProps();
    const { rerender } = render(<KanbanWorkspace {...props} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    rerender(<KanbanWorkspace {...props} presentationMode="card" />);
    const expected = { type: KANBAN_PRESENTATION_MESSAGE, nonce: "preview-nonce", presentation: { mode: "card" } };
    expect(postMessage).toHaveBeenCalledWith(expected, "*");
    postMessage.mockClear();
    dispatchPreviewReady(iframe, "preview-nonce");
    expect(postMessage).toHaveBeenCalledWith(expected, "*");
    postMessage.mockClear();
    fireEvent.load(iframe);
    expect(postMessage).toHaveBeenCalledWith(expected, "*");
    rerender(<KanbanWorkspace {...props} presentationMode="phone" />);
    expect(postMessage).toHaveBeenCalledWith({ ...expected, presentation: { mode: "phone" } }, "*");
    expect(screen.getByTitle("Demo Kanban")).toBe(iframe);
    postMessage.mockRestore();
  });

  it("identifies real Conversation card previews as card presentation", () => {
    render(<KanbanPreviewFrame projectName="Map" previewUrl="https://preview.invalid/index.html" previewNonce="preview-nonce" compact />);
    const iframe = screen.getByTitle("Map Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    expect(postMessage).toHaveBeenCalledWith({ type: KANBAN_PRESENTATION_MESSAGE, nonce: "preview-nonce", presentation: { mode: "card" } }, "*");
    postMessage.mockRestore();
  });
  it("lets the host wrap configuration content without duplicating its form or state", async () => {
    const props = createProps({
      configurationHeadingAction: <button type="button">Host rail action</button>,
      renderLayout: (layout) => (
        <div data-testid="host-layout">
          <aside aria-label="Host configuration rail">{layout.configuration}</aside>
          {layout.preview}
          {layout.mobileTrigger}
          {layout.drawerBackdrop}
        </div>
      ),
    });
    render(<KanbanWorkspace {...props} />);
    const rail = screen.getByRole("complementary", { name: "Host configuration rail" });
    expect(document.querySelector(".kanban-configuration-panel")).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Host rail action" })).toBeInTheDocument();
    fireEvent.change(within(rail).getByLabelText("标题"), { target: { value: "Host draft" } });
    await waitFor(() => expect(props.onSaveConfiguration).toHaveBeenCalledWith("default", { title: "Host draft", columns: "3" }));

    fireEvent.click(within(rail).getByRole("button", { name: "配置操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const dialog = screen.getByRole("dialog", { name: "重命名配置" });
    expect(document.querySelector(".kanban-workspace")?.contains(dialog)).toBe(true);
    expect(rail.contains(dialog)).toBe(false);
  });

  it("uses a full-width sandboxed preview when the project has no params", () => {
    render(<KanbanWorkspace {...createProps({ params: [], configurations: [] })} />);

    expect(document.querySelector(".kanban-workspace")).toHaveAttribute("data-has-params", "false");
    expect(screen.queryByLabelText("看板配置")).not.toBeInTheDocument();
    expect(screen.getByTitle("Demo Kanban")).toHaveAttribute("sandbox", "allow-scripts");
  });

  it("posts native parameter values with the preview nonce", () => {
    render(<KanbanWorkspace {...createProps()} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    fireEvent.load(iframe);

    expect(postMessage).toHaveBeenCalledWith({
      type: "steamharness:kanban-configuration",
      nonce: "preview-nonce",
      configuration: {
        id: "default",
        name: "默认配置",
        params: { title: "Roadmap", columns: 3 },
      },
    }, "*");
  });

  it("posts opaque database revision snapshots with the preview nonce", () => {
    const { rerender } = render(<KanbanWorkspace {...createProps()} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    rerender(<KanbanWorkspace {...createProps({
      databaseRevisions: [{ alias: "stocks", revision: "opaque-2" }],
    })} />);

    expect(postMessage).toHaveBeenCalledWith({
      type: "steamharness:kanban-database-revision",
      nonce: "preview-nonce",
      alias: "stocks",
      revision: "opaque-2",
    }, "*");

    postMessage.mockClear();
    fireEvent.load(iframe);
    expect(postMessage).toHaveBeenCalledWith({
      type: "steamharness:kanban-database-revision",
      nonce: "preview-nonce",
      alias: "stocks",
      revision: "opaque-2",
    }, "*");
  });

  it("accepts only a nonce-bound ready message from the current preview", async () => {
    render(<KanbanWorkspace {...createProps()} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;

    dispatchPreviewReady(iframe, "wrong-nonce");
    expect(screen.getByText("正在加载 HTML")).toBeInTheDocument();

    dispatchPreviewReady(iframe, "preview-nonce");
    await waitFor(() => expect(screen.queryByText("正在加载 HTML")).not.toBeInTheDocument());
  });

  it("dispatches bridge requests and returns nonce-bound results", async () => {
    const onBridgeRequest = vi.fn(async () => ({ version: 1 }));
    render(<KanbanWorkspace {...createProps({ onBridgeRequest })} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    dispatchBridgeRequest(iframe, {
      requestId: "request-1",
      operation: "kv.getValue",
      input: { database:"data", key: "board" },
    });

    await waitFor(() => expect(onBridgeRequest).toHaveBeenCalledWith({
      requestId: "request-1",
      operation: "kv.getValue",
      input: { database:"data", key: "board" },
    }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: "steamharness:kanban-bridge-response",
      nonce: "preview-nonce",
      requestId: "request-1",
      ok: true,
      value: { version: 1 },
    }, "*"));
  });

  it("rejects bridge request envelopes with unsupported host-routing fields", async () => {
    const onBridgeRequest = vi.fn(async () => ({ version: 1 }));
    render(<KanbanWorkspace {...createProps({ onBridgeRequest })} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    dispatchBridgeRequest(iframe, {
      requestId: "request-forged-project",
      operation: "kv.getValue",
      input: { database:"data", key: "board" },
      projectName: "another-project",
    });

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-forged-project",
      ok: false,
      error: expect.objectContaining({ code: "KANBAN_BRIDGE_INVALID_REQUEST" }),
    }), "*"));
    expect(onBridgeRequest).not.toHaveBeenCalled();
  });

  it("keeps an in-flight bridge response when the host callback identity changes", async () => {
    let resolveRequest!: (value: unknown) => void;
    const firstHandler = vi.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { rerender } = render(<KanbanWorkspace {...createProps({ onBridgeRequest: firstHandler })} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    dispatchBridgeRequest(iframe, {
      requestId: "request-stable",
      operation: "kv.getValue",
      input: { database:"data", key: "board" },
    });
    await waitFor(() => expect(firstHandler).toHaveBeenCalledOnce());

    rerender(<KanbanWorkspace {...createProps({ onBridgeRequest: vi.fn() })} />);
    resolveRequest({ version: 1 });

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-stable",
      ok: true,
      value: { version: 1 },
    }), "*"));
  });

  it("converts synchronous host bridge failures into safe responses", async () => {
    const onBridgeRequest = vi.fn(() => {
      throw Object.assign(new Error("Project data is unavailable."), {
        code: "KANBAN_DATA_OPERATION_FAILED",
      });
    });
    render(<KanbanWorkspace {...createProps({ onBridgeRequest })} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    dispatchBridgeRequest(iframe, {
      requestId: "request-sync-error",
      operation: "kv.getValue",
      input: { database:"data", key: "board" },
    });

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-sync-error",
      ok: false,
      error: {
        code: "KANBAN_DATA_OPERATION_FAILED",
        message: "Kanban project data operation failed.",
      },
    }), "*"));
  });

  it("ignores forged sources and nonces and rejects invalid operations", async () => {
    const onBridgeRequest = vi.fn();
    render(<KanbanWorkspace {...createProps({ onBridgeRequest })} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    dispatchBridgeRequest(iframe, {
      requestId: "wrong-nonce",
      operation: "kv.getValue",
      input: { database:"data", key: "board" },
    }, { nonce: "wrong" });
    dispatchBridgeRequest(iframe, {
      requestId: "wrong-source",
      operation: "kv.getValue",
      input: { database:"data", key: "board" },
    }, { source: window });
    dispatchBridgeRequest(iframe, {
      requestId: "invalid-operation",
      operation: "kv.deleteValue",
      input: { database:"data", key: "board" },
    });

    expect(onBridgeRequest).not.toHaveBeenCalled();
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "invalid-operation",
      ok: false,
      error: {
        code: "KANBAN_BRIDGE_INVALID_REQUEST",
        message: "Kanban bridge 请求无效。",
      },
    }), "*"));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: "wrong-nonce" }), "*");
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: "wrong-source" }), "*");
  });

  it("sanitizes bridge failures and drops responses from an old iframe generation", async () => {
    let rejectRequest!: (reason: unknown) => void;
    const onBridgeRequest = vi.fn(() => new Promise((_, reject) => { rejectRequest = reject; }));
    const { rerender } = render(<KanbanWorkspace {...createProps({ onBridgeRequest })} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    dispatchBridgeRequest(iframe, {
      requestId: "request-old",
      operation: "knowledge.listDocuments",
      input: { database:"data",},
    });
    await waitFor(() => expect(onBridgeRequest).toHaveBeenCalledOnce());
    rerender(<KanbanWorkspace {...createProps({
      onBridgeRequest,
      previewUrl: "https://preview.invalid/refreshed/index.html",
    })} />);
    rejectRequest(new Error("private path /Users/example/store"));
    await act(async () => { await Promise.resolve(); });

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-old" }), "*");
  });

  it("limits concurrent host bridge requests", async () => {
    const unresolved = new Promise(() => undefined);
    const onBridgeRequest = vi.fn(() => unresolved);
    render(<KanbanWorkspace {...createProps({ onBridgeRequest })} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    for (let index = 0; index < 17; index += 1) {
      dispatchBridgeRequest(iframe, {
        requestId: `request-${index}`,
        operation: "kv.getValue",
        input: { database:"data", key: `key-${index}` },
      });
    }

    await act(async () => { await Promise.resolve(); });
    expect(onBridgeRequest).toHaveBeenCalledTimes(16);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-16",
      ok: false,
      error: expect.objectContaining({ code: "KANBAN_BRIDGE_BUSY" }),
    }), "*"));
  });

  it("releases host concurrency slots after bridge requests time out", async () => {
    vi.useFakeTimers();
    const onBridgeRequest = vi.fn(() => new Promise(() => undefined));
    render(<KanbanWorkspace {...createProps({ onBridgeRequest })} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;

    for (let index = 0; index < 16; index += 1) {
      dispatchBridgeRequest(iframe, {
        requestId: `timeout-${index}`,
        operation: "kv.getValue",
        input: { database:"data", key: `key-${index}` },
      });
    }
    await act(async () => { await Promise.resolve(); });
    expect(onBridgeRequest).toHaveBeenCalledTimes(16);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    dispatchBridgeRequest(iframe, {
      requestId: "after-timeout",
      operation: "kv.getValue",
      input: { database:"data", key: "after-timeout" },
    });
    await act(async () => { await Promise.resolve(); });

    expect(onBridgeRequest).toHaveBeenCalledTimes(17);
  });

  it("returns to the loading state when a saved source refreshes the preview URL", async () => {
    const { rerender } = render(<KanbanWorkspace {...createProps()} />);
    dispatchPreviewReady(screen.getByTitle("Demo Kanban") as HTMLIFrameElement, "preview-nonce");
    await waitFor(() => expect(screen.queryByText("正在加载 HTML")).not.toBeInTheDocument());

    rerender(<KanbanWorkspace {...createProps({
      previewUrl: "https://preview.invalid/refreshed/index.html",
    })} />);

    expect(screen.getByText("正在加载 HTML")).toBeInTheDocument();
  });

  it("requests a fresh preview session when secure initialization times out", async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<KanbanWorkspace {...createProps({ onRetry })} />);

    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("HTML 预览未能完成安全初始化");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByText("正在加载 HTML")).toBeInTheDocument();
  });

  it("fills new manifest params from defaults and drops obsolete configuration values", async () => {
    const { rerender } = render(<KanbanWorkspace {...createProps()} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    rerender(<KanbanWorkspace {...createProps({
      params: [
        { name: "title", label: "标题", type: "string", defaultValue: "Roadmap" },
        { name: "theme", label: "主题", type: "string", defaultValue: "light" },
      ],
      configurations: CONFIGURATIONS.map((configuration) => ({
        ...configuration,
        values: { ...configuration.values, obsolete: "remove-me" },
      })),
    })} />);

    await waitFor(() => {
      expect(screen.getByLabelText("主题")).toHaveValue("light");
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        configuration: expect.objectContaining({
          params: { title: "Roadmap", theme: "light" },
        }),
      }), "*");
    });
  });

  it("injects only safe references after uploading multiple files", async () => {
    const onFileUpload = vi.fn(async () => [{
      id: "file-1",
      name: "brief.pdf",
      mimeType: "application/pdf",
      size: 42,
      kind: "file" as const,
      storage: "local" as const,
      createdAt: "2026-07-27T00:00:00.000Z",
      localAbsolutePath: "/Users/example/brief.pdf",
      storagePath: "/private/workflow-files/file-1/content",
    }]);
    render(<KanbanWorkspace {...createProps({
      params: [{ name: "attachments", label: "附件", type: "file", format: "json", multiple: true }],
      configurations: CONFIGURATIONS.map((configuration) => ({
        ...configuration,
        values: { attachments: "" },
      })),
      onFileUpload,
    })} />);
    const iframe = screen.getByTitle("Demo Kanban") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    fireEvent.click(screen.getByTitle("上传文件"));

    await waitFor(() => expect(onFileUpload).toHaveBeenCalledOnce());
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        params: {
          attachments: [{
            id: "file-1",
            name: "brief.pdf",
            mimeType: "application/pdf",
            size: 42,
            kind: "file",
            storage: "local",
            createdAt: "2026-07-27T00:00:00.000Z",
          }],
        },
      }),
    }), "*"));
  });

  it("shows a thumbnail for a single image, opens it, and preserves the reference on upload failure", async () => {
    const file = { id: "wf_abc123", name: "map.png", mimeType: "image/png", size: 3,
      kind: "image" as const, storage: "server" as const, createdAt: "2026-10-09T00:00:00Z" };
    let finish!: (files: typeof file[]) => void;
    const onFileUpload = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockRejectedValueOnce(new Error("Server disconnected"));
    const onOpenAttachment = vi.fn();
    render(<KanbanWorkspace {...createProps({
      params: [{ name: "imageFile", label: "底图", type: "file", accept: ["image/png"], multiple: false }],
      onFileUpload, onOpenAttachment, onResolveAttachmentPreview: async () => "data:image/png;base64,AP8A",
    })} />);
    fireEvent.click(screen.getByTitle("上传图片"));
    expect(screen.getByTitle("上传图片")).toBeDisabled();
    expect(screen.getByLabelText("新建配置")).toBeDisabled();
    await act(async () => { finish([file]); });
    await waitFor(() => expect(screen.getByAltText("map.png")).toHaveAttribute("src", "data:image/png;base64,AP8A"));
    fireEvent.click(screen.getByAltText("map.png"));
    await waitFor(() => expect(onOpenAttachment).toHaveBeenCalledWith(file, { download: false }));
    fireEvent.click(screen.getByTitle("上传图片"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Server disconnected"));
    expect(screen.getByAltText("map.png")).toBeInTheDocument();
    expect(screen.getByTitle("上传图片")).not.toBeDisabled();
  });

  it("ignores upload responses for a configuration that the host has replaced", async () => {
    const file = { id: "wf_abc123", name: "map.png", mimeType: "image/png", size: 3,
      kind: "image" as const, storage: "server" as const, createdAt: "2026-10-09T00:00:00Z" };
    let finish!: (files: typeof file[]) => void;
    const props = createProps({
      params: [{ name: "imageFile", label: "底图", type: "file", accept: ["image/png"], multiple: false }],
      onFileUpload: () => new Promise((resolve) => { finish = resolve; }),
    });
    const { rerender } = render(<KanbanWorkspace {...props} />);
    fireEvent.click(screen.getByTitle("上传图片"));
    rerender(<KanbanWorkspace {...props} activeConfigurationId="review" />);
    await act(async () => { finish([file]); });
    expect(screen.queryByAltText("map.png")).not.toBeInTheDocument();
    expect(props.onSaveConfiguration).not.toHaveBeenCalled();
  });

  it("preserves host changes to the active configuration while an upload is pending", async () => {
    const file = { id: "wf_abc123", name: "map.png", mimeType: "image/png", size: 3,
      kind: "image" as const, storage: "server" as const, createdAt: "2026-10-09T00:00:00Z" };
    let finish!: (files: typeof file[]) => void;
    const props = createProps({
      params: [{ name: "imageFile", label: "底图", type: "file", accept: ["image/png"], multiple: false }],
      onFileUpload: () => new Promise((resolve) => { finish = resolve; }),
    });
    const { rerender } = render(<KanbanWorkspace {...props} />);
    fireEvent.click(screen.getByTitle("上传图片"));
    rerender(<KanbanWorkspace {...props} configurations={props.configurations.map((item) => ({
      ...item, updatedAt: "2026-10-09T00:00:00Z", values: { ...item.values, imageFile: "[]" },
    }))} />);
    await act(async () => { finish([file]); });
    expect(screen.queryByAltText("map.png")).not.toBeInTheDocument();
    expect(props.onSaveConfiguration).not.toHaveBeenCalled();
  });

  it("flushes the current configuration before a debounced save is cleared by selection", async () => {
    const onSaveConfiguration = vi.fn(async () => undefined);
    const { rerender } = render(<KanbanWorkspace {...createProps({ onSaveConfiguration })} />);

    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Unsaved title" } });
    rerender(<KanbanWorkspace {...createProps({
      activeConfigurationId: "review",
      onSaveConfiguration,
    })} />);

    await waitFor(() => expect(onSaveConfiguration).toHaveBeenCalledWith("default", {
      title: "Unsaved title",
      columns: "3",
    }));
  });

  it("persists pending values before invoking an explicit configuration switch", async () => {
    const calls: string[] = [];
    const onSaveConfiguration = vi.fn(async () => { calls.push("save"); });
    const onSelectConfiguration = vi.fn(async () => { calls.push("select"); });
    render(<KanbanWorkspace {...createProps({ onSaveConfiguration, onSelectConfiguration })} />);

    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Before switch" } });
    fireEvent.click(screen.getByRole("button", { name: "选择配置" }));
    fireEvent.click(screen.getByRole("option", { name: "评审配置" }));

    await waitFor(() => expect(onSelectConfiguration).toHaveBeenCalledWith("review"));
    expect(onSaveConfiguration).toHaveBeenCalledWith("default", {
      title: "Before switch",
      columns: "3",
    });
    expect(calls).toEqual(["save", "select"]);
  });

  it("serializes debounced saves and exposes a retry after the newest save fails", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const onSaveConfiguration = vi.fn()
      .mockImplementationOnce(() => firstSave)
      .mockRejectedValueOnce(new Error("保存失败"))
      .mockResolvedValue(undefined);
    render(<KanbanWorkspace {...createProps({ onSaveConfiguration })} />);
    const title = screen.getByLabelText("标题");

    fireEvent.change(title, { target: { value: "First" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    fireEvent.change(title, { target: { value: "Second" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    expect(onSaveConfiguration).toHaveBeenCalledTimes(1);
    releaseFirst();
    await act(async () => {
      await firstSave;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSaveConfiguration).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("保存失败");
    expect(screen.getByRole("button", { name: "选择配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建配置" })).toBeDisabled();
    expect(title).toBeEnabled();
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "重试" }));
    await act(async () => { await Promise.resolve(); });
    expect(onSaveConfiguration).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "选择配置" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("已保存");
  });

  it("offers a direct retry for failed configuration actions", async () => {
    const onCreateConfiguration = vi.fn()
      .mockRejectedValueOnce(new Error("创建失败"))
      .mockResolvedValue(undefined);
    render(<KanbanWorkspace {...createProps({ onCreateConfiguration })} />);

    fireEvent.click(screen.getByRole("button", { name: "新建配置" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("创建失败"));
    fireEvent.click(screen.getByRole("button", { name: "重试新建配置" }));

    await waitFor(() => expect(onCreateConfiguration).toHaveBeenCalledTimes(2));
  });

  it("moves rename and duplicate actions into the configuration menu", async () => {
    const onRenameConfiguration = vi.fn(async () => undefined);
    const onDuplicateConfiguration = vi.fn(async () => undefined);
    render(<KanbanWorkspace {...createProps({ onRenameConfiguration, onDuplicateConfiguration })} />);

    const menuTrigger = screen.getByRole("button", { name: "配置操作" });
    fireEvent.click(menuTrigger);
    const menu = screen.getByRole("menu", { name: "配置操作" });
    expect(within(menu).getByRole("menuitem", { name: "重命名" })).toHaveFocus();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));

    const renameDialog = screen.getByRole("dialog", { name: "重命名配置" });
    const nameInput = within(renameDialog).getByRole("textbox", { name: "配置名称" });
    expect(nameInput).toHaveFocus();
    fireEvent.change(nameInput, { target: { value: "产品评审" } });
    fireEvent.click(within(renameDialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onRenameConfiguration).toHaveBeenCalledWith("default", "产品评审"));
    await waitFor(() => expect(menuTrigger).toHaveFocus());

    fireEvent.click(menuTrigger);
    fireEvent.click(within(screen.getByRole("menu", { name: "配置操作" })).getByRole("menuitem", { name: "复制" }));
    await waitFor(() => expect(onDuplicateConfiguration).toHaveBeenCalledWith("default"));
  });

  it("restores focus when configuration overlays close", async () => {
    render(<KanbanWorkspace {...createProps()} />);

    const pickerTrigger = screen.getByRole("button", { name: "选择配置" });
    fireEvent.click(pickerTrigger);
    const currentOption = screen.getByRole("option", { name: /默认配置/ });
    expect(currentOption).toHaveFocus();
    fireEvent.keyDown(currentOption, { key: "Escape" });
    await waitFor(() => expect(pickerTrigger).toHaveFocus());
    expect(screen.queryByRole("listbox", { name: "命名配置" })).toBeNull();

    const menuTrigger = screen.getByRole("button", { name: "配置操作" });
    fireEvent.click(menuTrigger);
    const renameItem = screen.getByRole("menuitem", { name: "重命名" });
    expect(renameItem).toHaveFocus();
    fireEvent.keyDown(renameItem, { key: "Escape" });
    await waitFor(() => expect(menuTrigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "配置操作" })).toBeNull();
  });

  it("keeps the rename dialog editable after a failed save", async () => {
    const onRenameConfiguration = vi.fn()
      .mockRejectedValueOnce(new Error("名称保存失败"))
      .mockResolvedValue(undefined);
    render(<KanbanWorkspace {...createProps({ onRenameConfiguration })} />);

    fireEvent.click(screen.getByRole("button", { name: "配置操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const dialog = screen.getByRole("dialog", { name: "重命名配置" });
    const nameInput = within(dialog).getByRole("textbox", { name: "配置名称" });
    fireEvent.change(nameInput, { target: { value: "失败后重试" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("名称保存失败"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(nameInput).toHaveValue("失败后重试");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onRenameConfiguration).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "重命名配置" })).toBeNull());
  });

  it("keeps delete confirmation open and retries a failed deletion in place", async () => {
    const onDeleteConfiguration = vi.fn()
      .mockRejectedValueOnce(new Error("删除失败"))
      .mockResolvedValue(undefined);
    render(<KanbanWorkspace {...createProps({ onDeleteConfiguration })} />);

    fireEvent.click(screen.getByRole("button", { name: "配置操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const dialog = screen.getByRole("alertdialog", { name: /删除“默认配置”配置/ });
    const deleteButton = within(dialog).getByRole("button", { name: "删除配置" });
    fireEvent.click(deleteButton);

    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("删除失败"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(deleteButton);
    await waitFor(() => expect(onDeleteConfiguration).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("supports listbox keyboard selection and confirms destructive deletion", async () => {
    const onSelectConfiguration = vi.fn();
    const onDeleteConfiguration = vi.fn();
    render(<KanbanWorkspace {...createProps({ onSelectConfiguration, onDeleteConfiguration })} />);
    const pickerTrigger = screen.getByRole("button", { name: "选择配置" });
    fireEvent.click(pickerTrigger);
    const listbox = screen.getByRole("listbox", { name: "命名配置" });
    const defaultOption = within(listbox).getByRole("option", { name: /默认配置/ });
    const reviewOption = within(listbox).getByRole("option", { name: "评审配置" });

    expect(defaultOption).toHaveFocus();
    fireEvent.keyDown(defaultOption, { key: "ArrowDown" });
    expect(document.activeElement).toBe(reviewOption);
    expect(onSelectConfiguration).not.toHaveBeenCalled();
    fireEvent.keyDown(reviewOption, { key: "Enter" });
    await waitFor(() => expect(onSelectConfiguration).toHaveBeenCalledWith("review"));
    await waitFor(() => expect(pickerTrigger).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "配置操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const dialog = screen.getByRole("alertdialog", { name: /删除“默认配置”配置/ });
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(onDeleteConfiguration).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除配置" }));
    await waitFor(() => expect(onDeleteConfiguration).toHaveBeenCalledWith("default"));
  });

  it("keeps the last configuration and exposes loading and error states", () => {
    const { rerender } = render(<KanbanWorkspace {...createProps({ configurations: [CONFIGURATIONS[0]!] })} />);
    fireEvent.click(screen.getByRole("button", { name: "配置操作" }));
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeDisabled();

    rerender(<KanbanWorkspace {...createProps({ loading: true })} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载看板");

    rerender(<KanbanWorkspace {...createProps({ error: "入口不存在" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("入口不存在");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

const CONFIGURATIONS: KanbanWorkspaceProps["configurations"] = [
  {
    id: "default",
    name: "默认配置",
    values: { title: "Roadmap", columns: "3" },
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  },
  {
    id: "review",
    name: "评审配置",
    values: { title: "Review", columns: "4" },
    createdAt: "2026-07-27T00:01:00.000Z",
    updatedAt: "2026-07-27T00:01:00.000Z",
  },
];

function createProps(overrides: Partial<KanbanWorkspaceProps> = {}): KanbanWorkspaceProps {
  return {
    projectName: "Demo",
    params: [
      { name: "title", label: "标题", type: "string", defaultValue: "Roadmap" },
      { name: "columns", label: "列数", type: "number", defaultValue: "3" },
    ],
    configurations: CONFIGURATIONS,
    activeConfigurationId: "default",
    previewUrl: "https://preview.invalid/index.html",
    previewNonce: "preview-nonce",
    onRetry: vi.fn(),
    onSelectConfiguration: vi.fn(),
    onCreateConfiguration: vi.fn(),
    onDuplicateConfiguration: vi.fn(),
    onRenameConfiguration: vi.fn(),
    onDeleteConfiguration: vi.fn(),
    onSaveConfiguration: vi.fn(),
    ...overrides,
  };
}

function dispatchPreviewReady(iframe: HTMLIFrameElement, nonce: string): void {
  const event = new MessageEvent("message", {
    data: { type: "steamharness:kanban-ready", nonce },
  });
  Object.defineProperty(event, "source", { value: iframe.contentWindow });
  fireEvent(window, event);
}

function dispatchBridgeRequest(
  iframe: HTMLIFrameElement,
  call: Record<string, unknown>,
  overrides: { nonce?: string; source?: MessageEventSource | null } = {},
): void {
  const event = new MessageEvent("message", {
    data: {
      type: "steamharness:kanban-bridge-request",
      nonce: overrides.nonce ?? "preview-nonce",
      ...call,
    },
  });
  Object.defineProperty(event, "source", { value: overrides.source ?? iframe.contentWindow });
  fireEvent(window, event);
}
