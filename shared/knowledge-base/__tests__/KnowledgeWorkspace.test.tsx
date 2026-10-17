import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import {
  KnowledgeWorkspace,
  type KnowledgeDocument,
  type KnowledgeDocumentListOptions,
  type KnowledgeDocumentPage,
  type KnowledgeDocumentRowMenuRequest,
  type KnowledgeDocumentSummary,
  type KnowledgeRepository,
  type KnowledgeResult,
  type KnowledgeSearchResult,
} from "@steamharness/knowledge-base";
import * as knowledgeUtils from "../utils";
import { i18n, initI18n } from "@steamharness/i18n";

describe("KnowledgeWorkspace", () => {
  it("loads summaries first and fetches markdown only after a document is selected", async () => {
    const getDocument = vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocument>> => success(createDocument()));
    const repository = createRepository({ getDocument });

    render(<KnowledgeWorkspace repository={repository} />);

    expect(await screen.findByRole("button", { name: "Guide" })).toBeTruthy();
    expect(getDocument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();
    expect(getDocument).toHaveBeenCalledWith("guide", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("opens a linked document even when its summary is outside the first page", async () => {
    const getDocument = vi.fn(async (id: string): Promise<KnowledgeResult<KnowledgeDocument>> => success({
      ...createDocument(), id, title: "Linked document", markdown: "Opened by card.",
    }));
    render(<KnowledgeWorkspace
      repository={createRepository({ getDocument })}
      initialDocumentId="linked-document"
    />);
    expect(await screen.findByText("Opened by card.")).toBeTruthy();
    expect(getDocument).toHaveBeenCalledWith("linked-document", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("keeps an initial list failure distinct from the empty state and retries accessibly", async () => {
    let attempts = 0;
    const listDocuments = vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocumentPage>> => {
      attempts += 1;
      return attempts === 1
        ? { errCode: 503, errMessage: "知识库暂时不可访问" }
        : success(createPage());
    });

    render(<KnowledgeWorkspace repository={createRepository({ listDocuments })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("知识库暂时不可访问");
    const list = screen.getByRole("region", { name: "知识库文档列表" });
    expect(within(list).getByText("加载知识库文档失败")).toBeTruthy();
    expect(within(list).queryByText("暂无文档")).toBeNull();

    fireEvent.click(within(list).getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "Guide" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("pages the summary list through the repository cursors", async () => {
    const firstPage = createPage({ hasMore: true, nextCursor: "next-page", total: 2 });
    const secondSummary = { ...createSummary(), id: "guide-2", title: "Guide 2" };
    const listDocuments = vi.fn(async (options: KnowledgeDocumentListOptions): Promise<KnowledgeResult<KnowledgeDocumentPage>> => success(
      options.cursor
        ? { items: [secondSummary], hasMore: false, total: 2 }
        : firstPage,
    ));
    render(<KnowledgeWorkspace repository={createRepository({ listDocuments })} pageSize={1} />);

    expect(await screen.findByRole("button", { name: "Guide" })).toBeTruthy();
    expect(screen.getByText("第 1 / 2 页")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByRole("button", { name: "Guide 2" })).toBeTruthy();
    expect(listDocuments).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next-page" }));
    expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
    // The last page has no further cursor.
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();

    // Going back re-requests that page's own cursor, which is the first page's
    // — the workspace does not fall back to "no cursor" by accident.
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(await screen.findByRole("button", { name: "Guide" })).toBeTruthy();
    expect(listDocuments).toHaveBeenCalledTimes(3);
    expect(listDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: undefined }));
  });

  it("resets summary pagination after creating a document so the next page cannot skip summaries", async () => {
    const first = { ...createSummary(), id: "first", title: "First" };
    const second = { ...createSummary(), id: "second", title: "Second" };
    const third = { ...createSummary(), id: "third", title: "Third" };
    const fourth = { ...createSummary(), id: "fourth", title: "Fourth" };
    const created = { ...createSummary(), id: "created", title: "Created" };
    let mutationApplied = false;
    const listDocuments = vi.fn(async (options: KnowledgeDocumentListOptions): Promise<KnowledgeResult<KnowledgeDocumentPage>> => {
      if (options.cursor === "2") {
        return success(mutationApplied
          ? { items: [second, third], hasMore: true, nextCursor: "4", total: 5 }
          : { items: [third, fourth], hasMore: false, total: 4 });
      }
      return success(mutationApplied
        ? { items: [created, first], hasMore: true, nextCursor: "2", total: 5 }
        : { items: [first, second], hasMore: true, nextCursor: "2", total: 4 });
    });
    const createDocument = vi.fn(async () => {
      mutationApplied = true;
      return success(created);
    });

    render(<KnowledgeWorkspace repository={createRepository({ listDocuments, createDocument })} pageSize={2} />);

    fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("button", { name: "Fourth" })).toBeTruthy();
    const listCallCountBeforeMutation = listDocuments.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "新建文档" }));
    const dialog = screen.getByRole("dialog", { name: "新建知识库文档" });
    fireEvent.change(within(dialog).getByLabelText("标题"), { target: { value: "Created" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "新建" }));

    expect(await screen.findByRole("button", { name: "Created" })).toBeTruthy();
    // A mutation resets the page stack: the list returns to the first page and
    // re-reads it without a cursor.
    await waitFor(() => expect(
      listDocuments.mock.calls.slice(listCallCountBeforeMutation).some(([options]) =>
        (options as KnowledgeDocumentListOptions).pageSize === 2
        && (options as KnowledgeDocumentListOptions).cursor === undefined,
      ),
    ).toBe(true));
    expect(screen.getByText("第 1 / 3 页")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fourth" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("button", { name: "Third" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Second" })).toBeTruthy();
  });

  it("keeps a create draft open when the repository rejects the write", async () => {
    const createDocument = vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocumentSummary>> => ({
      errCode: 409,
      errMessage: "标题已存在",
    }));
    render(<KnowledgeWorkspace repository={createRepository({ createDocument })} />);

    fireEvent.click(screen.getByRole("button", { name: "新建文档" }));
    const dialog = screen.getByRole("dialog", { name: "新建知识库文档" });
    fireEvent.change(within(dialog).getByLabelText("标题"), { target: { value: "保留草稿" } });
    fireEvent.change(within(dialog).getByLabelText("Markdown"), { target: { value: "# Draft\n\nKeep me" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "新建" }));

    await waitFor(() => expect(createDocument).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "新建知识库文档" })).toBeTruthy();
    expect((within(dialog).getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# Draft\n\nKeep me");
    expect(screen.getByRole("alert")).toHaveTextContent("标题已存在");
  });

  it("creates an English draft from the active locale without marking the baseline dirty", async () => {
    const previousLanguage = i18n.language;
    try {
      initI18n({ preference: "en" });
      const onDirtyChange = vi.fn();
      render(<KnowledgeWorkspace repository={createRepository()} onDirtyChange={onDirtyChange} />);

      fireEvent.click(await screen.findByRole("button", { name: "New document" }));
      const dialog = screen.getByRole("dialog", { name: "New knowledge base document" });
      expect((within(dialog).getByLabelText("Markdown") as HTMLTextAreaElement).value)
        .toBe("# New document\n\n");
      expect(onDirtyChange).not.toHaveBeenCalledWith(true);

      fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "English guide" } });
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it("confirms before closing an unsaved create draft and restores it when editing continues", async () => {
    const onDirtyChange = vi.fn();
    render(<KnowledgeWorkspace repository={createRepository()} onDirtyChange={onDirtyChange} />);

    fireEvent.click(await screen.findByRole("button", { name: "新建文档" }));
    const createDialog = screen.getByRole("dialog", { name: "新建知识库文档" });
    fireEvent.change(within(createDialog).getByLabelText("标题"), { target: { value: "未保存的新文档" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(within(createDialog).getByRole("button", { name: "关闭新建知识库文档" }));
    const discardDialog = await screen.findByRole("dialog", { name: "放弃未保存的更改？" });
    fireEvent.click(within(discardDialog).getByRole("button", { name: "继续编辑" }));

    const restoredDialog = await screen.findByRole("dialog", { name: "新建知识库文档" });
    expect((within(restoredDialog).getByLabelText("标题") as HTMLInputElement).value).toBe("未保存的新文档");

    fireEvent.click(within(restoredDialog).getByRole("button", { name: "取消" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "放弃未保存的更改？" })).getByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建知识库文档" })).toBeNull());
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("asks before replacing an unsaved document draft", async () => {
    const secondSummary = { ...createSummary(), id: "guide-2", title: "Second guide" };
    const secondDocument = { ...createDocument(), id: "guide-2", title: "Second guide", markdown: "# Second\n\nSecond document body." };
    const getDocument = vi.fn(async (documentId: string): Promise<KnowledgeResult<KnowledgeDocument>> => success(
      documentId === "guide-2" ? secondDocument : createDocument(),
    ));
    render(<KnowledgeWorkspace repository={createRepository({
      listDocuments: async () => success(createPage({ items: [createSummary(), secondSummary], total: 2 })),
      getDocument,
    })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "# Guide\n\nUnsaved draft." } });

    fireEvent.click(screen.getByRole("button", { name: "Second guide" }));
    const discardDialog = await screen.findByRole("dialog", { name: "放弃未保存的更改？" });
    expect(getDocument).toHaveBeenCalledTimes(1);
    fireEvent.click(within(discardDialog).getByRole("button", { name: "继续编辑" }));
    expect(screen.getByRole("heading", { name: "Guide", level: 2 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Second guide" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "放弃未保存的更改？" })).getByRole("button", { name: "放弃更改" }));

    expect(await screen.findByText("Second document body.")).toBeTruthy();
    expect(getDocument).toHaveBeenLastCalledWith("guide-2", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("keeps document navigation disabled until a pending save settles", async () => {
    const save = createDeferred<KnowledgeResult<KnowledgeDocumentSummary>>();
    const secondSummary = { ...createSummary(), id: "guide-2", title: "Second guide" };
    const secondDocument = { ...createDocument(), id: "guide-2", title: "Second guide", markdown: "# Second\n\nSecond document body." };
    const getDocument = vi.fn(async (documentId: string) => success(
      documentId === "guide-2" ? secondDocument : createDocument(),
    ));
    render(<KnowledgeWorkspace repository={createRepository({
      listDocuments: async () => success(createPage({ items: [createSummary(), secondSummary], total: 2 })),
      getDocument,
      updateDocument: vi.fn(() => save.promise),
    })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "# Guide\n\nSaved draft." } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Second guide" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Second guide" }));
    expect(getDocument).toHaveBeenCalledTimes(1);

    save.resolve(success({ ...createSummary(), title: "Guide" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Second guide" })).not.toBeDisabled());
    expect(screen.getByRole("heading", { name: "Guide", level: 2 })).toBeTruthy();
  });

  it("refreshes summaries after saving without downloading the selected markdown again", async () => {
    const savedMarkdown = "# Guide\n\n" + "x".repeat(300_000);
    const getDocument = vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocument>> => success({
      ...createDocument(),
      markdown: savedMarkdown,
    }));
    const updateDocument = vi.fn(async (_documentId: string, input: { title?: string; markdown?: string }) =>
      success({ ...createSummary(), title: input.title ?? "Guide" }),
    );
    const listDocuments = vi.fn(async () => success(createPage()));
    render(<KnowledgeWorkspace repository={createRepository({ getDocument, listDocuments, updateDocument })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("文档内容较大")).toBeTruthy();
    expect(getDocument).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: `${savedMarkdown}\nSaved.` } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(updateDocument).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("renders the current draft when switching an edited document back to preview", async () => {
    render(<KnowledgeWorkspace repository={createRepository()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "# Guide\n\nDraft preview body." } });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));

    expect(await screen.findByText("Draft preview body.")).toBeTruthy();
    expect(screen.queryByText("Shared knowledge markdown.")).toBeNull();
  });

  it("defers large markdown preview metrics while the editor draft changes", async () => {
    const byteLength = vi.spyOn(knowledgeUtils, "getKnowledgeMarkdownByteLength");
    const imageCount = vi.spyOn(knowledgeUtils, "countMarkdownImages");
    render(<KnowledgeWorkspace repository={createRepository()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    byteLength.mockClear();
    imageCount.mockClear();

    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "x".repeat(200_001) } });

    expect(byteLength).not.toHaveBeenCalled();
    expect(imageCount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByText("文档内容较大")).toBeTruthy();
    expect(byteLength).toHaveBeenCalledTimes(1);
    expect(imageCount).not.toHaveBeenCalled();
    byteLength.mockRestore();
    imageCount.mockRestore();
  });

  it("ignores a late list response after the repository changes", async () => {
    const deferred = createDeferred<KnowledgeResult<KnowledgeDocumentPage>>();
    const repositoryA = createRepository({ listDocuments: vi.fn(() => deferred.promise) });
    const repositoryB = createRepository({
      listDocuments: vi.fn(async () => success({
        items: [{ ...createSummary(), id: "current", title: "Current project" }],
        hasMore: false,
        total: 1,
      })),
    });
    const view = render(<KnowledgeWorkspace repository={repositoryA} />);

    view.rerender(<KnowledgeWorkspace repository={repositoryB} />);
    expect(await screen.findByRole("button", { name: "Current project" })).toBeTruthy();

    deferred.resolve(success(createPage({ items: [{ ...createSummary(), id: "stale", title: "Stale project" }] })));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Stale project" })).toBeNull();
  });

  it("does not restore a stale selection after a refresh while the user opens another document", async () => {
    const refresh = createDeferred<KnowledgeResult<KnowledgeDocumentPage>>();
    const secondSummary = { ...createSummary(), id: "guide-2", title: "Second guide" };
    const guide = createDocument();
    const second = { ...createDocument(), id: "guide-2", title: "Second guide", markdown: "# Second\n\nSelected after refresh." };
    let listCalls = 0;
    const listDocuments = vi.fn(() => {
      listCalls += 1;
      return listCalls === 1
        ? Promise.resolve(success(createPage({ items: [createSummary(), secondSummary], total: 2 })))
        : refresh.promise;
    });
    const getDocument = vi.fn(async (documentId: string) => success(documentId === "guide-2" ? second : guide));
    const repository = createRepository({ listDocuments, getDocument });
    const view = render(<KnowledgeWorkspace repository={repository} refreshToken={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();

    view.rerender(<KnowledgeWorkspace repository={repository} refreshToken={1} />);
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Second guide" }));
    expect(await screen.findByText("Selected after refresh.")).toBeTruthy();

    refresh.resolve(success(createPage({ items: [createSummary(), secondSummary], total: 2 })));
    await waitFor(() => expect(getDocument.mock.calls.filter(([documentId]) => documentId === "guide")).toHaveLength(1));
    expect(screen.getByRole("heading", { name: "Second guide" })).toBeTruthy();
  });

  it("reloads summaries from the toolbar refresh action", async () => {
    let listCalls = 0;
    const listDocuments = vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocumentPage>> => {
      listCalls += 1;
      return success(createPage({
        items: [{ ...createSummary(), title: listCalls === 1 ? "Guide" : "Guide refreshed" }],
      }));
    });
    render(<KnowledgeWorkspace repository={createRepository({ listDocuments })} />);

    expect(await screen.findByRole("button", { name: "Guide" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新知识库" }));

    expect(await screen.findByRole("button", { name: "Guide refreshed" })).toBeTruthy();
    expect(listDocuments).toHaveBeenCalledTimes(2);
  });

  it("hands the document index to a host rail instead of the built-in search", async () => {
    render(
      <KnowledgeWorkspace
        repository={createRepository()}
        documentRail={(rail) => (
          <div data-slot="host-knowledge-rail">
            <span>{`documents: ${rail.total ?? 0}`}</span>
            <button type="button" onClick={rail.refresh}>{rail.busy ? "refreshing" : "refresh"}</button>
            {rail.list}
          </div>
        )}
      />,
    );

    expect(await screen.findByText("documents: 1")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    // The index lives in the host rail; the workspace does not add a second copy.
    const lists = screen.getAllByRole("region", { name: "知识库文档列表" });
    expect(lists).toHaveLength(1);
    expect(within(lists[0]).getByRole("button", { name: "Guide" })).toBeTruthy();
  });

  it("runs the document search from a host rail's own field", async () => {
    const searchDocuments = vi.fn(async () => success({
      query: "删除",
      documentsSearched: 1,
      totalMatches: 1,
      matchesTruncated: false,
      maxMatches: 200,
      pageSize: 200,
      hasMore: false,
      matches: [{
        documentId: "guide",
        title: "Guide",
        lineNumber: 1,
        line: "host rail search hit",
        before: [],
        after: [],
      }],
    }));
    render(
      <KnowledgeWorkspace
        repository={createRepository({ searchDocuments })}
        documentRail={(rail) => (
          <div data-slot="host-knowledge-rail">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                rail.search.submit();
              }}
            >
              <input
                type="search"
                aria-label="搜索知识库文档"
                value={rail.search.value}
                onChange={(event) => rail.search.onValueChange(event.target.value)}
              />
            </form>
            {rail.list}
            {rail.search.node}
          </div>
        )}
      />,
    );

    // Enter submits, exactly as the built-in search form does: typing alone
    // never queries and never shows results.
    const field = await screen.findByRole("searchbox", { name: "搜索知识库文档" });
    fireEvent.change(field, { target: { value: "删除" } });
    expect(searchDocuments).not.toHaveBeenCalled();
    expect(screen.queryByText("host rail search hit")).toBeNull();

    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(await screen.findByText("host rail search hit")).toBeTruthy();
    expect(searchDocuments).toHaveBeenCalledWith(expect.objectContaining({ query: "删除" }));
  });

  it("opens a document picked from a host rail and keeps that rail", async () => {
    render(
      <KnowledgeWorkspace
        repository={createRepository()}
        documentRail={(rail) => <div data-slot="host-knowledge-rail">{rail.list}</div>}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();

    const list = screen.getByRole("region", { name: "知识库文档列表" });
    expect(within(list).getByRole("button", { name: "Guide" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "返回文档列表" })).toBeNull();
  });

  it("reloads the index when a host rail asks for a refresh", async () => {
    const listDocuments = vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocumentPage>> => success(createPage()));
    render(
      <KnowledgeWorkspace
        repository={createRepository({ listDocuments })}
        documentRail={(rail) => (
          <button type="button" onClick={rail.refresh}>{`reload ${rail.total ?? 0}`}</button>
        )}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "reload 1" }));
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
  });

  it("keeps the pager with the list a host rail places", async () => {
    const firstPage = createPage({ hasMore: true, nextCursor: "next-page", total: 2 });
    const listDocuments = vi.fn(async (options: KnowledgeDocumentListOptions): Promise<KnowledgeResult<KnowledgeDocumentPage>> => success(
      options.cursor
        ? { items: [{ ...createSummary(), id: "guide-2", title: "Guide 2" }], hasMore: false, total: 2 }
        : firstPage,
    ));
    render(
      <KnowledgeWorkspace
        repository={createRepository({ listDocuments })}
        pageSize={1}
        documentRail={(rail) => <div data-slot="host-knowledge-rail">{rail.list}</div>}
      />,
    );

    const rail = await screen.findByRole("complementary", { name: "知识库文档导航" });
    fireEvent.click(await within(rail).findByRole("button", { name: "下一页" }));

    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next-page" })));
    expect(await screen.findByRole("button", { name: "Guide 2" })).toBeTruthy();
  });

  it("raises a document row's menu with the workspace's own edit and remove flows", async () => {
    const editDocument = vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocument>> => success(createDocument()));
    const deleteDocument = vi.fn(async () => success({ id: "guide", deleted: true }));
    const rowMenu = vi.fn();
    render(
      <KnowledgeWorkspace
        repository={createRepository({ deleteDocument, getDocument: editDocument })}
        documentRowMenu={rowMenu}
      />,
    );

    fireEvent.contextMenu(await screen.findByRole("button", { name: "Guide" }));

    expect(rowMenu).toHaveBeenCalledTimes(1);
    const request = rowMenu.mock.calls[0][0] as KnowledgeDocumentRowMenuRequest;
    expect(request.document.id).toBe("guide");
    expect(request.menuId).toContain("guide");

    request.edit();
    expect((await screen.findByLabelText("Markdown") as HTMLTextAreaElement).value).toContain("Shared knowledge markdown.");

    request.remove();
    const dialog = await screen.findByRole("dialog", { name: "删除文档" });
    expect(within(dialog).getByText(/Guide/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith("guide", expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("deletes the row the menu belongs to without closing another open document", async () => {
    const first = { ...createSummary(), id: "guide", title: "Guide" };
    const second = { ...createSummary(), id: "guide-2", title: "Second guide" };
    const deleteDocument = vi.fn(async () => success({ id: "guide-2", deleted: true }));
    const rowMenu = vi.fn();
    render(
      <KnowledgeWorkspace
        repository={createRepository({
          deleteDocument,
          listDocuments: vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocumentPage>> => success(createPage({ items: [first, second], total: 2 }))),
          getDocument: vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocument>> => success({ ...createDocument(), id: "guide-2", title: "Second guide" })),
        })}
        documentRowMenu={rowMenu}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Second guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Guide" }));
    const request = rowMenu.mock.calls[0][0] as KnowledgeDocumentRowMenuRequest;
    request.remove();
    const dialog = await screen.findByRole("dialog", { name: "删除文档" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith("guide", expect.objectContaining({ signal: expect.any(AbortSignal) })));
    // The document that was open is still open: only the deleted row leaves.
    expect(screen.getByRole("heading", { name: "Second guide", level: 2 })).toBeTruthy();
  });

  it("gives the rail's column back to the document when the host collapses it", async () => {
    const repository = createRepository();
    const view = render(<KnowledgeWorkspace repository={repository} documentRail={(rail) => <div>{rail.list}</div>} />);

    expect(await screen.findByRole("region", { name: "知识库文档列表" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "知识库文档导航" })).toBeTruthy();

    view.rerender(<KnowledgeWorkspace repository={repository} documentRail={(rail) => <div>{rail.list}</div>} railCollapsed />);

    expect(screen.queryByRole("complementary", { name: "知识库文档导航" })).toBeNull();
    // The document itself stays: only the rail's column is gone.
    expect(screen.getByRole("region", { name: "知识库文档主体" })).toBeTruthy();
  });

  it("does not rebuild a host rail while an editor draft changes", async () => {
    let railBuilds = 0;
    render(
      <KnowledgeWorkspace
        repository={createRepository()}
        documentRail={(rail) => {
          railBuilds += 1;
          return <div data-slot="host-knowledge-rail">{rail.list}</div>;
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const buildsAfterOpen = railBuilds;

    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "typed" } });

    expect(railBuilds).toBe(buildsAfterOpen);
  });

  it("ignores a stale page response after a refresh and pages from the fresh cursor", async () => {
    const oldPage = createDeferred<KnowledgeResult<KnowledgeDocumentPage>>();
    const firstSummary = createSummary();
    const secondSummary = { ...createSummary(), id: "guide-2", title: "Second guide" };
    const thirdSummary = { ...createSummary(), id: "guide-3", title: "Third guide" };
    let initialRequests = 0;
    const listDocuments = vi.fn((options: KnowledgeDocumentListOptions): Promise<KnowledgeResult<KnowledgeDocumentPage>> => {
      if (options.cursor === "old-next") return oldPage.promise;
      if (options.cursor === "new-next") {
        return Promise.resolve(success({ items: [thirdSummary], hasMore: false, total: 3 }));
      }
      initialRequests += 1;
      return Promise.resolve(success(
        initialRequests === 1
          ? { items: [firstSummary], hasMore: true, nextCursor: "old-next", total: 2 }
          : { items: [firstSummary, secondSummary], hasMore: true, nextCursor: "new-next", total: 3 },
      ));
    });
    const repository = createRepository({ listDocuments });
    const view = render(<KnowledgeWorkspace repository={repository} refreshToken={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith(expect.objectContaining({ cursor: "old-next" })));

    view.rerender(<KnowledgeWorkspace repository={repository} refreshToken={1} />);
    expect(await screen.findByRole("button", { name: "Second guide" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("button", { name: "Third guide" })).toBeTruthy();
    expect(listDocuments).toHaveBeenCalledWith(expect.objectContaining({ cursor: "new-next" }));

    // The request the refresh cancelled must not land on the new page stack.
    oldPage.resolve(success({ items: [], hasMore: false, total: 2 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Third guide" })).toBeTruthy());
  });

  it("keeps an unsaved later-page editor open when refresh only returns the first page", async () => {
    const firstSummary = createSummary();
    const secondSummary = { ...createSummary(), id: "guide-2", title: "Second guide" };
    const secondDocument = { ...createDocument(), id: "guide-2", title: "Second guide", markdown: "# Second\n\nSaved second body." };
    const listDocuments = vi.fn((options: KnowledgeDocumentListOptions): Promise<KnowledgeResult<KnowledgeDocumentPage>> => Promise.resolve(success(
      options.cursor === "next-page"
        ? { items: [secondSummary], hasMore: false, total: 2 }
        : { items: [firstSummary], hasMore: true, nextCursor: "next-page", total: 2 },
    )));
    const repository = createRepository({
      listDocuments,
      getDocument: async (documentId) => success(documentId === "guide-2" ? secondDocument : createDocument()),
    });
    const view = render(<KnowledgeWorkspace repository={repository} refreshToken={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
    fireEvent.click(await screen.findByRole("button", { name: "Second guide" }));
    expect(await screen.findByText("Saved second body.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "# Second\n\nUnsaved later-page draft." } });

    view.rerender(<KnowledgeWorkspace repository={repository} refreshToken={1} />);

    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("heading", { name: "Second guide", level: 2 })).toBeTruthy();
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toContain("Unsaved later-page draft.");
  });

  it("shows a repository rejection and can load the document again", async () => {
    let shouldReject = true;
    const getDocument = vi.fn(async (): Promise<KnowledgeResult<KnowledgeDocument>> => {
      if (shouldReject) {
        shouldReject = false;
        throw new Error("连接中断");
      }
      return success(createDocument());
    });
    render(<KnowledgeWorkspace repository={createRepository({ getDocument })} />);

    const documentButton = await screen.findByRole("button", { name: "Guide" });
    fireEvent.click(documentButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("连接中断");

    fireEvent.click(documentButton);
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a rejected stale document request", async () => {
    const first = createDeferred<KnowledgeResult<KnowledgeDocument>>();
    const second = createDeferred<KnowledgeResult<KnowledgeDocument>>();
    const getDocument = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<KnowledgeWorkspace repository={createRepository({ getDocument })} />);

    const documentButton = await screen.findByRole("button", { name: "Guide" });
    fireEvent.click(documentButton);
    fireEvent.click(documentButton);
    first.reject(new Error("已取消的旧请求"));
    second.resolve(success(createDocument()));

    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears search matches after a successful document mutation", async () => {
    const staleSearchLine = "删除后不应保留的搜索结果";
    const deleteDocument = vi.fn(async (documentId: string) => success({ id: documentId, deleted: true }));
    const searchDocuments = vi.fn(async () => success({
      query: "删除",
      documentsSearched: 1,
      totalMatches: 1,
      matchesTruncated: false,
      maxMatches: 200,
      pageSize: 200,
      hasMore: false,
      matches: [{
        documentId: "guide",
        title: "Guide",
        lineNumber: 1,
        line: staleSearchLine,
        before: [],
        after: [],
      }],
    }));
    render(<KnowledgeWorkspace repository={createRepository({ deleteDocument, searchDocuments })} />);

    const search = await screen.findByRole("searchbox", { name: "搜索知识库文档" });
    fireEvent.change(search, { target: { value: "删除" } });
    fireEvent.submit(search.closest("form") as HTMLFormElement);
    expect(await screen.findByText(staleSearchLine)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    expect(await screen.findByText("Shared knowledge markdown.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除文档" })).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith("guide", expect.anything()));
    await waitFor(() => expect(screen.queryByText(staleSearchLine)).toBeNull());
  });

  it("resets search pagination loading when a new search interrupts the previous page", async () => {
    const oldPageMore = createDeferred<KnowledgeResult<KnowledgeSearchResult>>();
    const searchDocuments = vi.fn((options: { query: string; cursor?: string }) => {
      if (options.cursor === "old-next") return oldPageMore.promise;
      if (options.query === "new") {
        return Promise.resolve(success({
          query: "new",
          documentsSearched: 1,
          totalMatches: 2,
          matchesTruncated: false,
          maxMatches: 200,
          pageSize: 200,
          hasMore: true,
          nextCursor: "new-next",
          matches: [{
            documentId: "guide",
            title: "Guide",
            lineNumber: 2,
            line: "new search result",
            before: [],
            after: [],
          }],
        }));
      }
      return Promise.resolve(success({
        query: "old",
        documentsSearched: 1,
        totalMatches: 2,
        matchesTruncated: false,
        maxMatches: 200,
        pageSize: 200,
        hasMore: true,
        nextCursor: "old-next",
        matches: [{
          documentId: "guide",
          title: "Guide",
          lineNumber: 1,
          line: "old search result",
          before: [],
          after: [],
        }],
      }));
    });
    render(<KnowledgeWorkspace repository={createRepository({ searchDocuments })} />);

    const search = await screen.findByRole("searchbox", { name: "搜索知识库文档" });
    fireEvent.change(search, { target: { value: "old" } });
    fireEvent.submit(search.closest("form") as HTMLFormElement);
    expect(await screen.findByText("old search result")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "加载更多结果" }));
    expect(screen.getByRole("button", { name: "加载更多结果" })).toBeDisabled();

    fireEvent.change(search, { target: { value: "new" } });
    fireEvent.submit(search.closest("form") as HTMLFormElement);
    expect(await screen.findByText("new search result")).toBeTruthy();
    expect(screen.getByRole("button", { name: "加载更多结果" })).not.toBeDisabled();

    oldPageMore.resolve(success(createSearchResult()));
  });

  it("uses the markdown performance guards for large documents and screenshot-heavy previews", async () => {
    const byteLength = vi.spyOn(TextEncoder.prototype, "encode");
    const largeDocument = { ...createDocument(), markdown: "x".repeat(2_000_000) };
    const largeRepository = createRepository({ getDocument: vi.fn(async () => success(largeDocument)) });
    const { unmount } = render(<KnowledgeWorkspace repository={largeRepository} />);

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("文档内容较大")).toBeTruthy();
    expect(byteLength).not.toHaveBeenCalled();
    unmount();
    byteLength.mockRestore();

    const unicodeLargeDocument = { ...createDocument(), markdown: "中".repeat(66_667) };
    const unicodeLargeRepository = createRepository({ getDocument: vi.fn(async () => success(unicodeLargeDocument)) });
    const unicodeView = render(<KnowledgeWorkspace repository={unicodeLargeRepository} />);
    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("文档内容较大")).toBeTruthy();
    unicodeView.unmount();

    const imageMarkdown = Array.from({ length: 49 }, (_, index) => `![${index}](https://example.test/${index}.png)`).join("\n\n");
    render(<KnowledgeWorkspace repository={createRepository({ getDocument: vi.fn(async () => success({ ...createDocument(), markdown: imageMarkdown })) })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("截图较多，预览已切换为稳定模式")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载 0" }));
    expect(await screen.findByAltText("0")).toBeTruthy();
  });
});

function createRepository(overrides: Partial<KnowledgeRepository> = {}): KnowledgeRepository {
  return {
    listDocuments: async () => success(createPage()),
    getDocument: async () => success(createDocument()),
    createDocument: async (input) => success({ ...createSummary(), id: input.id ?? "created", title: input.title }),
    updateDocument: async (documentId, input) => success({ ...createSummary(), id: documentId, title: input.title }),
    deleteDocument: async (documentId) => success({ id: documentId, deleted: true }),
    searchDocuments: async () => success(createSearchResult()),
    ...overrides,
  };
}

function createSummary(): KnowledgeDocumentSummary {
  return {
    id: "guide",
    title: "Guide",
    markdownPreview: "Shared knowledge markdown.",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

function createDocument(): KnowledgeDocument {
  return {
    id: "guide",
    title: "Guide",
    markdown: "# Guide\n\nShared knowledge markdown.",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

function createPage(overrides: Partial<KnowledgeDocumentPage> = {}): KnowledgeDocumentPage {
  return {
    items: [createSummary()],
    hasMore: false,
    total: 1,
    ...overrides,
  };
}

function createSearchResult(): KnowledgeSearchResult {
  return {
    query: "guide",
    documentsSearched: 1,
    totalMatches: 0,
    matchesTruncated: false,
    maxMatches: 200,
    pageSize: 200,
    hasMore: false,
    matches: [],
  };
}

function success<T>(data: T): KnowledgeResult<T> {
  return { errCode: 0, errMessage: "", data };
}

function createDeferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T) => resolvePromise(value),
    reject: (reason?: unknown) => rejectPromise(reason),
  };
}
