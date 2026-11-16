import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n/react";
import { App } from "../App";
import { apiClient } from "../api";
import type { AuthPrincipal } from "../types";

const principal: AuthPrincipal = {
  kind: "user_session",
  userId: "navigation-user",
  displayName: "Navigation User",
  isSystemAdmin: true,
};

beforeEach(async () => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/projects");
  await i18n.changeLanguage("zh-CN");
  vi.spyOn(apiClient, "health").mockResolvedValue({
    errCode: 0, errMessage: "", data: {
      status: "ok", versions: { serverVersion: "0.1.0", coreVersion: "0.1.0" },
      currentRelease: null, deployment: { server: null, serverWeb: null },
    },
  });
  vi.spyOn(apiClient, "getSession").mockResolvedValue({ errCode: 0, errMessage: "", data: { authenticated: true, principal } });
  vi.spyOn(apiClient, "listProjects").mockResolvedValue({ errCode: 0, errMessage: "", data: {items:[],total:0,page:1,pageSize:20} });
  vi.spyOn(apiClient, "getMe").mockResolvedValue({ errCode: 0, errMessage: "", data: { principal, profile: null } });
  vi.spyOn(apiClient, "listApiKeys").mockResolvedValue({ errCode: 0, errMessage: "", data: { items: [] } });
  vi.spyOn(apiClient, "listAdminUsers").mockResolvedValue({errCode:0,errMessage:"",data:{items:[]}});
  vi.spyOn(apiClient, "listAuditEvents");
});

afterEach(() => { vi.restoreAllMocks(); });

describe("main sidebar submenus", () => {
  it("expands settings and administration in place without leaving the project list", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    const settings = within(nav).getByRole("button", { name: "设置" });
    const admin = within(nav).getByRole("button", { name: "管理中心" });
    expect(settings).toHaveAttribute("aria-expanded", "false");
    expect(admin).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(settings);
    fireEvent.click(admin);
    expect(settings).toHaveAttribute("aria-expanded", "true");
    expect(admin).toHaveAttribute("aria-expanded", "true");
    expect(within(settings.closest("li")!).getByRole("button", { name: "个人信息" })).toHaveAttribute("data-slot", "sidebar-menu-sub-button");
    expect(within(admin.closest("li")!).getByRole("button", { name: "用户管理" })).toHaveAttribute("data-slot", "sidebar-menu-sub-button");
    expect(within(nav).getByRole("button", { name: "项目工作台" })).toHaveAttribute("aria-current", "page");
    expect(window.location.pathname).toBe("/projects");
    expect(screen.getByRole("heading", { name: "项目工作台" })).toBeTruthy();
    expect(apiClient.getMe).not.toHaveBeenCalled();
    expect(apiClient.listAdminUsers).not.toHaveBeenCalled();
    expect(apiClient.listAuditEvents).not.toHaveBeenCalled();

    fireEvent.click(settings);
    expect(within(nav).queryByRole("button", { name: "个人信息" })).toBeNull();
    expect(admin).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the main entries and current child visible after selecting a settings page", async () => {
    render(<App />);
    const homeNav = await screen.findByRole("navigation", { name: "主导航" });
    fireEvent.click(within(homeNav).getByRole("button", { name: "设置" }));
    fireEvent.click(within(homeNav).getByRole("button", { name: "系统设置" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings/appearance"));

    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("button", { name: "设置" })).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("button", { name: "管理中心" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "系统设置" })).toHaveAttribute("aria-current", "page");
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    await waitFor(() => expect(apiClient.getMe).toHaveBeenCalled());

    fireEvent.click(within(nav).getByRole("button", { name: "项目工作台" }));
    expect(await screen.findByRole("heading", { name: "项目工作台" })).toBeTruthy();
    expect(window.location.pathname).toBe("/projects");
  });

  it.each([
    { path: "/settings/appearance", group: "设置", child: "系统设置" },
    { path: "/admin/users", group: "管理中心", child: "用户管理" },
  ])("expands the current group when opening $path directly", async ({ path, group, child }) => {
    window.history.replaceState(null, "", path);
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    const parent = within(nav).getByRole("button", { name: group });
    expect(parent).toHaveAttribute("aria-expanded", "true");
    expect(parent).not.toHaveAttribute("aria-current");
    expect(within(parent.closest("li")!).getByRole("button", { name: child })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: "项目工作台" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: group === "设置" ? "管理中心" : "设置" })).toBeTruthy();
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("hides the administration group without administration permissions", async () => {
    vi.mocked(apiClient.getSession).mockResolvedValue({ errCode: 0, errMessage: "", data: {
      authenticated: true, principal: { ...principal, isSystemAdmin: false },
    } });
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByRole("button", { name: "管理中心" })).toBeNull();
    expect(within(nav).getByRole("button", { name: "设置" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the mobile drawer open for expansion and closes it after selecting a child", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    render(<App />);
    await screen.findByRole("heading", { name: "项目工作台" });
    fireEvent.click(screen.getByRole("button", { name: "切换侧边栏" }));
    const sheet = await screen.findByRole("dialog", { name: "侧边栏" });
    fireEvent.click(within(sheet).getByRole("button", { name: "设置" }));
    expect(sheet).toBeVisible();
    expect(window.location.pathname).toBe("/projects");
    fireEvent.click(within(sheet).getByRole("button", { name: "系统设置" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings/appearance"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "侧边栏" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "切换侧边栏" }));
    const reopened = await screen.findByRole("dialog", { name: "侧边栏" });
    expect(within(reopened).getByRole("button", { name: "系统设置" })).toHaveAttribute("aria-current", "page");
    expect(within(reopened).getByRole("button", { name: "项目工作台" })).toBeTruthy();
  });
});
