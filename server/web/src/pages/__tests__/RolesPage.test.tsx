import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RolesPage } from "../RolesPage";
import type { PermissionGroup, RoleRecord } from "../../types";

describe("RolesPage create dialog", () => {
  it("keeps the dialog bounded so header and footer stay visible while body scrolls", () => {
    render(
      <RolesPage
        roles={[]}
        groups={createGroups()}
        onRefresh={vi.fn()}
        onCreateRole={vi.fn()}
        onUpdateRole={vi.fn()}
        onDeleteRole={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新建角色" }));

    const dialog = screen.getByRole("dialog", { name: "新建角色" });
    expect(within(dialog).getByText("新建角色")).toBeTruthy();
    expect(within(dialog).getByText(/角色权限会按组展示/)).toBeTruthy();
    expect(within(dialog).getByText("权限分组")).toBeTruthy();
    expect(within(dialog).getByText(/已选 0 项权限/)).toBeTruthy();

    const dialogEl = dialog as HTMLElement;
    expect(dialogEl.className ?? "").toMatch(/max-h-\[min\(88vh/);
    expect(dialogEl.className ?? "").toMatch(/overflow-hidden/);

    const footer = within(dialog).getByText("保存角色").closest('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    expect(footer?.className ?? "").toMatch(/border-t/);
  });

  it("submits the new role with selected permissions", () => {
    const onCreateRole = vi.fn();
    render(
      <RolesPage
        roles={[]}
        groups={createGroups()}
        onRefresh={vi.fn()}
        onCreateRole={onCreateRole}
        onUpdateRole={vi.fn()}
        onDeleteRole={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新建角色" }));
    const dialog = screen.getByRole("dialog", { name: "新建角色" });

    fireEvent.change(within(dialog).getByLabelText("角色名称"), { target: { value: "QA Reviewer" } });
    fireEvent.click(within(dialog).getByLabelText(/读取公开项目/));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存角色" }));
    expect(onCreateRole).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "创建角色" })).getByRole("button", { name: "创建角色" }));

    expect(onCreateRole).toHaveBeenCalledWith({
      name: "QA Reviewer",
      description: undefined,
      permissions: ["projects.read_public"],
    });
  });

  it("toggles the whole permission group when the group checkbox is clicked", () => {
    render(
      <RolesPage
        roles={[]}
        groups={createGroups()}
        onRefresh={vi.fn()}
        onCreateRole={vi.fn()}
        onUpdateRole={vi.fn()}
        onDeleteRole={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新建角色" }));
    const dialog = screen.getByRole("dialog", { name: "新建角色" });

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "切换 项目 整组权限" }));

    const publicRead = within(dialog).getByRole("checkbox", { name: /读取公开项目/ });
    const privateRead = within(dialog).getByRole("checkbox", { name: /读取全部项目/ });
    expect(publicRead.getAttribute("data-slot")).toBe("checkbox");
    expect(publicRead.getAttribute("aria-checked")).toBe("true");
    expect(privateRead.getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByText(/已选 2 项权限/)).toBeTruthy();
  });
});

function createRoles(): RoleRecord[] {
  return [];
}

function createGroups(): PermissionGroup[] {
  return [
    {
      id: "projects",
      label: "项目",
      permissions: [
        {
          key: "projects.read_public",
          label: "读取公开项目",
          description: "读取公开项目或公开信息。",
          group: "projects",
        },
        {
          key: "projects.read_all",
          label: "读取全部项目",
          description: "查看项目列表、详情、版本和结构。",
          group: "projects",
        },
      ],
    },
    {
      id: "users",
      label: "用户与角色",
      permissions: [
        {
          key: "users.read",
          label: "查看用户",
          description: "读取用户列表与用户状态。",
          group: "users",
        },
      ],
    },
  ];
}
