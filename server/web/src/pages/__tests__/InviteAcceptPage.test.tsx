import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteAcceptPage } from "../InviteAcceptPage";
import { apiClient } from "../../api";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      lookupInvitation: vi.fn(),
      acceptInvitation: vi.fn(),
    },
  };
});

const mockedLookup = vi.mocked(apiClient.lookupInvitation);
const mockedAccept = vi.mocked(apiClient.acceptInvitation);

beforeEach(() => {
  mockedLookup.mockReset();
  mockedAccept.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("InviteAcceptPage", () => {
  it("shows project name and role on a valid invitation and accepts on click", async () => {
    mockedLookup.mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        invitation: {
          id: "inv-1",
          workflowId: "demo",
          token: "tok-abc",
          role: "viewer",
          createdAt: "2026-06-18T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        project: { id: "demo", name: "Demo Project" },
      },
    });
    mockedAccept.mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        invitation: {
          id: "inv-1",
          workflowId: "demo",
          token: "tok-abc",
          role: "viewer",
          createdAt: "2026-06-18T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          acceptedBy: "user-1",
          acceptedAt: "2026-06-18T01:00:00.000Z",
        },
        member: {
          workflowId: "demo",
          userId: "user-1",
          role: "viewer",
          createdAt: "2026-06-18T01:00:00.000Z",
        },
      },
    });
    const handlers = renderPage();
    expect(await screen.findByText(/加入项目 Demo Project/)).toBeTruthy();
    expect(screen.getByText("viewer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" }));
    await waitFor(() => expect(screen.getByText(/已加入项目 demo/)).toBeTruthy());
    expect(mockedAccept).toHaveBeenCalledWith("tok-abc");
    expect(handlers.onNavigateProject).not.toHaveBeenCalled();
  });

  it("shows a missing message when the token is unknown", async () => {
    mockedLookup.mockResolvedValue({
      errCode: 404,
      errMessage: "Invitation not found.",
      data: undefined as never,
    });
    const handlers = renderPage();
    expect(await screen.findByText("邀请链接无效")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回项目工作台" }));
    expect(handlers.onNavigateProjects).toHaveBeenCalledTimes(1);
  });

  it("shows a revoked message when the invitation has been revoked", async () => {
    mockedLookup.mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        invitation: {
          id: "inv-1",
          workflowId: "demo",
          token: "tok-abc",
          role: "viewer",
          createdAt: "2026-06-18T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          revokedAt: "2026-06-18T00:30:00.000Z",
        },
        project: { id: "demo", name: "Demo Project" },
      },
    });
    renderPage();
    expect(await screen.findByText("邀请已撤销")).toBeTruthy();
  });

  it("shows an expired message when the invitation has expired", async () => {
    mockedLookup.mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        invitation: {
          id: "inv-1",
          workflowId: "demo",
          token: "tok-abc",
          role: "viewer",
          createdAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2020-01-08T00:00:00.000Z",
        },
        project: { id: "demo", name: "Demo Project" },
      },
    });
    renderPage();
    expect(await screen.findByText("邀请已过期")).toBeTruthy();
  });

  it("treats an account-login-required 401 as a login prompt, not a hard error", async () => {
    mockedLookup.mockResolvedValue({
      errCode: 401,
      errMessage: "Account login is required.",
      data: undefined as never,
    });
    const handlers = renderPage();
    expect(await screen.findByText("请先登录")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "登录后接受邀请" }));
    expect(handlers.onNavigateLogin).toHaveBeenCalledTimes(1);
  });
});

function renderPage() {
  const onNavigateProjects = vi.fn();
  const onNavigateProject = vi.fn();
  const onNavigateLogin = vi.fn();
  render(
    <InviteAcceptPage
      token="tok-abc"
      onNavigateProjects={onNavigateProjects}
      onNavigateProject={onNavigateProject}
      onNavigateLogin={onNavigateLogin}
    />,
  );
  return { onNavigateProjects, onNavigateProject, onNavigateLogin };
}