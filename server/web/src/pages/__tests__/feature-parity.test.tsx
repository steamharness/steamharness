
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AuditEventPage, KVEntryPage } from "../../types";
import { AuditPage } from "../AuditPage";
import { KVInspectorPage } from "../ProjectKVPage";

describe("server/web feature parity", () => {

  it("adds KV run filters and opens JSON details in a dialog", async () => {
    const onFiltersChange = vi.fn();
    const onLoadEntry = vi.fn(async (entry: KVEntryPage["items"][number]) => ({
      errCode: 0,
      errMessage: "",
      data: { ...entry, value: { nested: true } },
    } as const));
    renderWithTheme(
      <KVInspectorPage
        kvPage={createKVPage()}
        filters={{ query: "", scope: "all", valueType: "all", conversationId: "", runId: "" }}
        pageIndex={0}
        pageSize={20}
        onFiltersChange={onFiltersChange}
        onRefresh={vi.fn()}
        onPageChange={vi.fn()}
        onLoadEntry={onLoadEntry}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("runId"), { target: { value: "run-1" } });
    expect(onFiltersChange).toHaveBeenCalledWith({ query: "", scope: "all", valueType: "all", conversationId: "", runId: "run-1" });

    fireEvent.click(screen.getByRole("button", { name: "查看 KV 详情" }));
    const detailDialog = screen.getByRole("dialog", { name: "KV 详情" });
    expect(detailDialog).toBeTruthy();
    expect(within(detailDialog).getAllByText("project").length).toBeGreaterThan(0);
    expect(screen.getAllByText("run-1").length).toBeGreaterThan(0);
    expect(onLoadEntry).toHaveBeenCalledWith(expect.objectContaining({ key: "settings.demo" }));
    expect(await screen.findByText(/"nested": true/)).toBeTruthy();
  });

  it("shows audit page filters, details and empty state", () => {
    const onFiltersChange = vi.fn();
    const onOpenDetail = vi.fn();
    const initialRender = renderWithTheme(
      <AuditPage
        auditPage={createAuditPage()}
        filters={{
          from: "",
          to: "",
          actorUserId: "",
          principalKind: "",
          eventType: "",
          resourceType: "",
          resourceId: "",
          outcome: "all",
        }}
        pageIndex={0}
        pageSize={20}
        selectedEventId={null}
        onFiltersChange={onFiltersChange}
        onRefresh={vi.fn()}
        onPageChange={vi.fn()}
        onOpenDetail={onOpenDetail}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("用户 ID"), { target: { value: "user-1" } });
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "user-1" }));
    fireEvent.click(screen.getByRole("button", { name: "查看审计详情" }));
    expect(onOpenDetail).toHaveBeenCalledWith("audit-1");
    expect(screen.getByText("workflow.publish")).toBeTruthy();
    initialRender.unmount();

    const detailRender = renderWithTheme(
      <AuditPage
        auditPage={createAuditPage()}
        filters={{
          from: "",
          to: "",
          actorUserId: "",
          principalKind: "",
          eventType: "",
          resourceType: "",
          resourceId: "",
          outcome: "all",
        }}
        pageIndex={0}
        pageSize={20}
        selectedEventId="audit-1"
        onFiltersChange={vi.fn()}
        onRefresh={vi.fn()}
        onPageChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(detailRender.getByRole("dialog")).toBeTruthy();
    expect(detailRender.getByText(/脱敏后的字段/)).toBeTruthy();
    expect(detailRender.getByText(/"projectName": "demo"/)).toBeTruthy();
    detailRender.unmount();

    renderWithTheme(
      <AuditPage
        auditPage={{ items: [], hasMore: false, total: 0 }}
        filters={{
          from: "",
          to: "",
          actorUserId: "",
          principalKind: "",
          eventType: "",
          resourceType: "",
          resourceId: "",
          outcome: "all",
        }}
        pageIndex={0}
        pageSize={20}
        selectedEventId={null}
        onFiltersChange={vi.fn()}
        onRefresh={vi.fn()}
        onPageChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByText("没有审计事件")).toBeTruthy();
  });
});

function renderWithTheme(node: React.ReactElement) {
  return render(node);
}

function createAuditPage(): AuditEventPage {
  return {
    items: [
      {
        id: "audit-1",
        principalKind: "admin_session",
        actorUserId: "user-1",
        actorProfileId: "user-1",
        actorDisplayName: "Admin User",
        eventType: "workflow.publish",
        resourceType: "workflow_version",
        resourceId: "demo:1.0.0",
        outcome: "success",
        requestIp: "127.0.0.1",
        userAgent: "Mozilla/5.0",
        context: { projectName: "demo", token: "abcd...wxyz" },
        createdAt: "2026-06-18T08:00:00.000Z",
      },
    ],
    hasMore: false,
    total: 1,
  };
}

function createKVPage(overrides: Partial<KVEntryPage["items"][number]> = {}): KVEntryPage {
  return {
    total: 1,
    hasMore: false,
    items: [{
      storageKind: "kv",
      scope: "project",
      key: "settings.demo",
      valueType: "object",
      valueSizeBytes: 42,
      valuePreview: "{\"nested\":true}",
      projectId: "demo",
      updatedAt: "2026-05-26T00:00:00.000Z",
      lastProjectId: "demo",
      lastRunId: "run-1",
      ...overrides,
    }],
  };
}
