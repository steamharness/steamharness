import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n/react";
import { App } from "../App";
import { apiClient } from "../api";

const authenticatedSession = {
  errCode: 0,
  errMessage: "",
  data: {
    authenticated: true,
    principal: { kind: "admin_session" as const, userId: "login-user", displayName: "Admin", isSystemAdmin: true },
  },
};
const emptyProjects = { errCode: 0, errMessage: "", data: { items: [], total: 0, page: 1, pageSize: 20 } };

beforeEach(async () => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/login");
  await i18n.changeLanguage("zh-CN");
  vi.spyOn(apiClient, "health").mockResolvedValue({ errCode: 503, errMessage: "Health unavailable." });
});

afterEach(() => vi.restoreAllMocks());

describe("account session and project loading", () => {
  it.each([404, 500, 503])("keeps password login valid when project loading returns %s and allows retry", async (errCode) => {
    vi.spyOn(apiClient, "getSession")
      .mockResolvedValueOnce({ errCode: 0, errMessage: "", data: { authenticated: false } })
      .mockResolvedValue(authenticatedSession);
    vi.spyOn(apiClient, "loginWithPassword").mockResolvedValue(authenticatedSession);
    const listProjects = vi.spyOn(apiClient, "listProjects").mockResolvedValue({ errCode, errMessage: "Project listing unavailable." });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("邮箱"), { target: { value: "admin@example.com" } });
    const password = screen.getByLabelText("密码");
    fireEvent.change(password, { target: { value: "test-password" } });
    fireEvent.submit(password.closest("form")!);

    expect(await screen.findByRole("heading", { name: "项目工作台" })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("Project listing unavailable.");
    expect(screen.queryByRole("heading", { name: "账号登录" })).toBeNull();
    expect(screen.queryByText("登录失败")).toBeNull();
    expect(screen.queryByText("没有匹配的项目")).toBeNull();
    expect(window.location.pathname).toBe("/projects");

    listProjects.mockResolvedValue(emptyProjects);
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]!);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText("没有匹配的项目")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "账号登录" })).toBeNull();
  });

  it("opens the signed-in console while health and projects are still pending", async () => {
    vi.spyOn(apiClient, "getSession").mockResolvedValue(authenticatedSession);
    vi.mocked(apiClient.health).mockReturnValue(new Promise(() => {}));
    vi.spyOn(apiClient, "listProjects").mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "项目工作台" })).toBeVisible();
    expect(await screen.findByRole("progressbar", { name: "正在加载表格" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "账号登录" })).toBeNull();
  });

  it("rechecks the account session after a project 401 and keeps a valid session", async () => {
    const getSession = vi.spyOn(apiClient, "getSession").mockResolvedValue(authenticatedSession);
    vi.spyOn(apiClient, "listProjects").mockResolvedValue({ errCode: 401, errMessage: "Project access rejected." });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Project access rejected.");
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "项目工作台" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "账号登录" })).toBeNull();
  });

  it("returns to login when the rechecked account session has expired", async () => {
    vi.spyOn(apiClient, "getSession")
      .mockResolvedValueOnce(authenticatedSession)
      .mockResolvedValue({ errCode: 401, errMessage: "Session expired." });
    vi.spyOn(apiClient, "listProjects").mockResolvedValue({ errCode: 401, errMessage: "Authentication required." });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "账号登录" })).toBeVisible();
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(screen.queryByText("Authentication required.")).toBeNull();
  });
});
