import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LayoutDashboard, Settings } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@workflow-code/i18n/react";
import { AppLayout } from "../AppLayout";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });
afterEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage("zh-CN"); });

function layoutProps() {
  return {
    currentLabel: "Alpha Project",
    navigationLabel: "Alpha Project",
    navItems: [{ id: "overview", label: "概览", icon: LayoutDashboard, active: true, onClick: vi.fn() }],
    onBrandClick: vi.fn(),
    onLogout: vi.fn(),
  };
}

describe("AppLayout", () => {
  it("shows one contextual navigation without a separate return action", () => {
    const props = layoutProps();
    render(<AppLayout {...props}><div>Project content</div></AppLayout>);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(nav.querySelectorAll('[data-slot="sidebar-group"]')).toHaveLength(1);
    expect(within(nav).getByText("Alpha Project")).toBeTruthy();
    expect(within(nav).queryByRole("button", { name: "项目工作台" })).toBeNull();
    expect(screen.queryByRole("button", { name: "返回项目工作台" })).toBeNull();
    const overview = within(nav).getByRole("button", { name: "概览" });
    expect(overview).toHaveAttribute("data-active", "true");
    fireEvent.click(overview);
    expect(props.navItems[0]!.onClick).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Workflow Code" }));
    expect(props.onBrandClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("main")).toHaveTextContent("Project content");
  });

  it("allows the sidebar to be hidden and restored", () => {
    render(<AppLayout {...layoutProps()}>Content</AppLayout>);
    const sidebar = document.querySelector("[data-slot=sidebar][data-state]");
    fireEvent.click(screen.getByRole("button", { name: "切换侧边栏" }));
    expect(sidebar).toHaveAttribute("data-state", "collapsed");
    fireEvent.click(screen.getByRole("button", { name: "切换侧边栏" }));
    expect(sidebar).toHaveAttribute("data-state", "expanded");
  });

  it("closes the mobile sheet after selecting a destination", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    const props = layoutProps();
    render(<AppLayout {...props}>Content</AppLayout>);
    fireEvent.click(screen.getByRole("button", { name: "切换侧边栏" }));
    const sheet = await screen.findByRole("dialog", { name: "侧边栏" });
    fireEvent.click(within(sheet).getByRole("button", { name: "概览" }));
    expect(props.navItems[0]!.onClick).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each(["brand", "account"])("closes the mobile sheet after navigating from %s", async (destination) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    const props = layoutProps();
    const onSettings = vi.fn();
    render(<AppLayout {...props} principalLabel="Workflow Admin"
      principalMenuActions={[{ label: "设置", icon: Settings, onSelect: onSettings }]}>Content</AppLayout>);
    fireEvent.click(screen.getByRole("button", { name: "切换侧边栏" }));
    const sheet = await screen.findByRole("dialog", { name: "侧边栏" });
    if (destination === "brand") {
      fireEvent.click(within(sheet).getByRole("button", { name: "Workflow Code" }));
      expect(props.onBrandClick).toHaveBeenCalledOnce();
    } else {
      fireEvent.pointerDown(within(sheet).getByRole("button", { name: /Workflow Admin/ }), { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole("menuitem", { name: "设置" }));
      expect(onSettings).toHaveBeenCalledOnce();
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("exposes account actions and logout from the account menu", async () => {
    const props = layoutProps();
    const onSettings = vi.fn();
    render(<AppLayout {...props} principalLabel="Workflow Admin" principalEmail="admin@example.com"
      principalMenuActions={[{ label: "设置", icon: Settings, onSelect: onSettings }]}>Content</AppLayout>);
    fireEvent.pointerDown(screen.getByRole("button", { name: /Workflow Admin/ }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "设置" }));
    expect(onSettings).toHaveBeenCalledOnce();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Workflow Admin/ }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "退出系统" }));
    expect(props.onLogout).toHaveBeenCalledOnce();
  });

  it("marks only the final breadcrumb as the current page", () => {
    const onProject = vi.fn();
    render(<AppLayout {...layoutProps()} breadcrumbs={[
      { label: "项目工作台" },
      { label: "Alpha Project", onClick: onProject },
      { label: "概览" },
    ]}>Content</AppLayout>);
    const breadcrumbs = screen.getByRole("navigation", { name: "面包屑导航" });
    expect(breadcrumbs.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(within(breadcrumbs).getByRole("link", { name: "概览" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(breadcrumbs).getByRole("button", { name: "Alpha Project" }));
    expect(onProject).toHaveBeenCalledOnce();
  });

  it("localizes sidebar and dialog controls when the language changes", async () => {
    render(<AppLayout {...layoutProps()}>Content</AppLayout>);
    expect(screen.getByRole("button", { name: "切换侧边栏" })).toBeVisible();
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
    render(<Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>Project dialog</DialogTitle></DialogContent></Dialog>);
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(screen.getByRole("button", { name: "关闭" })).toBeVisible();
  });
});
