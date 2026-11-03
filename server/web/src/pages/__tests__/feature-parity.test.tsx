
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AuditEventPage } from "../../types";
import { AuditPage } from "../AuditPage";

describe("server/web feature parity", () => {

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
    expect(screen.getByText("steamharness.publish")).toBeTruthy();
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
        eventType: "steamharness.publish",
        resourceType: "project_version",
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
