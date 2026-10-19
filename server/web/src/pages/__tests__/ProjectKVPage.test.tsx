import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { KVInspectorPage } from "../ProjectKVPage";
import type { KVEntryDetail, KVEntryPage } from "../../types";

describe("KVInspectorPage table", () => {
  it("uses Chinese pagination footer labels and keeps server-side page callbacks", () => {
    const onPageChange = vi.fn();
    render(
      <KVInspectorPage
        kvPage={createKVPage({ total: 45, hasMore: true })}
        filters={{ query: "", scope: "all", valueType: "all", conversationId: "", runId: "" }}
        pageIndex={0}
        pageSize={20}
        onFiltersChange={vi.fn()}
        onRefresh={vi.fn()}
        onPageChange={onPageChange}
      />,
    );

    // Server/web is the default unit gate, so the management KV
    // grid must keep Chinese pagination instead of English fallback text.
    const footer = screen.getByLabelText("分页页脚");
    expect(within(footer).getByText("每页行数:")).toBeTruthy();
    expect(within(footer).getByText("第 1 条到第 2 条，共 45 条")).toBeTruthy();
    expect(within(footer).getByText("20")).toBeTruthy();
    expect(within(footer).queryByText("Rows per page:")).toBeNull();

    fireEvent.click(within(footer).getByRole("button", { name: "下一页" }));
    expect(onPageChange).toHaveBeenCalledWith("next");
  });

  it("deletes the opened KV entry after confirming and refreshes the page", async () => {
    const onDeleteEntry = vi.fn(async () => ({ errCode: 0, errMessage: "", data: { removed: true } } as const));
    const onRefresh = vi.fn();
    const onLoadEntry = vi.fn(async (entry: KVEntryPage["items"][number]) => ({
      errCode: 0,
      errMessage: "",
      data: createKVDetail(entry),
    } as const));
    render(createProjectKVPageElement({
      kvPage: createKVPage(),
      filters: { query: "", scope: "project", valueType: "all", conversationId: "", runId: "" },
      onFiltersChange: vi.fn(),
      onRefresh,
      onLoadEntry,
      onDeleteEntry,
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "查看 KV 详情" })[0]);
    await screen.findByText(/"enabled": true/);

    fireEvent.click(screen.getByRole("button", { name: "删除条目" }));
    // Destructive KV deletion goes through the shared confirm dialog first.
    const confirm = screen.getByRole("alertdialog");
    expect(within(confirm).getByText("删除 KV 数据")).toBeTruthy();
    // The key shows up in both the description and the scope/key details.
    expect(within(confirm).getAllByText(/project\.feature\.flag/).length).toBeGreaterThan(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "删除条目" }));

    await waitFor(() => {
      expect(onDeleteEntry).toHaveBeenCalledWith(expect.objectContaining({ key: "project.feature.flag" }));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "KV 详情" })).toBeNull();
  });

  it("keeps the KV detail open and reports a failed delete", async () => {
    const onDeleteEntry = vi.fn(async () => ({ errCode: 404, errMessage: 'KV entry "project.feature.flag" does not exist.' } as const));
    const onRefresh = vi.fn();
    const onLoadEntry = vi.fn(async (entry: KVEntryPage["items"][number]) => ({
      errCode: 0,
      errMessage: "",
      data: createKVDetail(entry),
    } as const));
    render(createProjectKVPageElement({
      kvPage: createKVPage(),
      filters: { query: "", scope: "project", valueType: "all", conversationId: "", runId: "" },
      onFiltersChange: vi.fn(),
      onRefresh,
      onLoadEntry,
      onDeleteEntry,
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "查看 KV 详情" })[0]);
    await screen.findByText(/"enabled": true/);

    fireEvent.click(screen.getByRole("button", { name: "删除条目" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除条目" }));

    expect(await screen.findByText('KV entry "project.feature.flag" does not exist.')).toBeTruthy();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "KV 详情" })).toBeTruthy();
  });

  it("hides the KV delete action when the page cannot delete entries", async () => {
    render(createProjectKVPageElement({
      kvPage: createKVPage(),
      filters: { query: "", scope: "project", valueType: "all", conversationId: "", runId: "" },
      onFiltersChange: vi.fn(),
      onRefresh: vi.fn(),
      onLoadEntry: vi.fn(async (entry: KVEntryPage["items"][number]) => ({
        errCode: 0,
        errMessage: "",
        data: createKVDetail(entry),
      } as const)),
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "查看 KV 详情" })[0]);
    await screen.findByText(/"enabled": true/);
    expect(screen.queryByRole("button", { name: "删除条目" })).toBeNull();
  });

  it("refreshes the expanded KV panel summary when the current row changes", async () => {
    const onLoadEntry = vi.fn(async (entry: KVEntryPage["items"][number]) => ({
      errCode: 0,
      errMessage: "",
      data: createKVDetail(entry),
    } as const));
    const props = {
      filters: { query: "", scope: "all" as const, valueType: "all" as const, conversationId: "", runId: "" },
      pageIndex: 0,
      pageSize: 20,
      onFiltersChange: vi.fn(),
      onRefresh: vi.fn(),
      onPageChange: vi.fn(),
      onOpenLog: vi.fn(),
      onLoadEntry,
    };
    const { rerender } = render(
      <KVInspectorPage
        {...props}
        kvPage={createKVPage()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "查看 KV 详情" })[0]);
    expect(await screen.findByText(/"enabled": true/)).toBeTruthy();

    // Refreshes may keep the same row identity but update its value
    // preview; the expanded panel must not keep showing stale loaded JSON.
    rerender(
      <KVInspectorPage
        {...props}
        kvPage={createKVPage({
          items: [
            {
              ...createKVPage().items[0],
              valuePreview: "{\"enabled\":false}",
              valueSizeBytes: 19,
              updatedAt: "2026-05-26T12:00:00.000Z",
            },
          ],
          total: 1,
        })}
      />,
    );

    const detailDialog = screen.getByRole("dialog", { name: "KV 详情" });
    expect(within(detailDialog).getByText("{\"enabled\":false}")).toBeTruthy();
    expect(await within(detailDialog).findByText(/"enabled": false/)).toBeTruthy();
    expect(screen.queryByText(/"enabled": true/)).toBeNull();
  });
});

function createProjectKVPageElement({
  kvPage,
  filters,
  loading,
  onFiltersChange,
  onRefresh,
  onLoadEntry,
  onDeleteEntry,
}: {
  kvPage: KVEntryPage;
  filters: { query: string; scope: "project"; valueType: "all" | "object"; conversationId: string; runId: string };
  loading?: string;
  onFiltersChange: ComponentProps<typeof KVInspectorPage>["onFiltersChange"];
  onRefresh: () => void;
  onLoadEntry: ComponentProps<typeof KVInspectorPage>["onLoadEntry"];
  onDeleteEntry?: ComponentProps<typeof KVInspectorPage>["onDeleteEntry"];
}) {
  return (
    <KVInspectorPage
      kvPage={kvPage}
      filters={filters}
      loading={loading}
      pageIndex={1}
      pageSize={20}
      onFiltersChange={onFiltersChange}
      onRefresh={onRefresh}
      onPageChange={vi.fn()}
      onLoadEntry={onLoadEntry}
      onDeleteEntry={onDeleteEntry}
    />
  );
}

function createKVPage(overrides: Partial<KVEntryPage> = {}): KVEntryPage {
  return {
    total: 2,
    hasMore: false,
    items: [
      {
        storageKind: "kv",
        scope: "project",
        key: "project.feature.flag",
        valueType: "object",
        valueSizeBytes: 18,
        valuePreview: "{\"enabled\":true}",
        projectId: "demo",
        updatedAt: "2026-05-26T11:26:25.000Z",
        lastProjectId: "demo",
        lastRunId: "run-1",
      },
      {
        storageKind: "kv",
        scope: "project",
        key: "project.cache.ttl",
        valueType: "number",
        valueSizeBytes: 3,
        valuePreview: "600",
        projectId: "demo",
        updatedAt: "2026-05-26T11:30:00.000Z",
      },
    ],
    ...overrides,
  };
}

function createKVDetail(entry: KVEntryPage["items"][number]): KVEntryDetail {
  return {
    ...entry,
    value: entry.key === "project.cache.ttl" ? 600 : { enabled: !entry.valuePreview.includes("false") },
  };
}
