import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api";
import { AccountInvitePage } from "../AccountInvitePage";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      lookupAccountInvitation: vi.fn(),
      acceptAccountInvitation: vi.fn(),
    },
  };
});

const lookupAccountInvitation = vi.mocked(apiClient.lookupAccountInvitation);
const acceptAccountInvitation = vi.mocked(apiClient.acceptAccountInvitation);

describe("AccountInvitePage", () => {
  beforeEach(() => {
    lookupAccountInvitation.mockReset();
    acceptAccountInvitation.mockReset();
  });

  it("sets an initial password and creates a signed-in session", async () => {
    lookupAccountInvitation.mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        invitation: {
          email: "new-user@example.com",
          displayName: "New User",
          expiresAt: "2099-08-26T00:00:00.000Z",
        },
      },
    });
    acceptAccountInvitation.mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        authenticated: true,
        principal: {
          kind: "user_session",
          userId: "user-1",
          email: "new-user@example.com",
          displayName: "Updated User",
        },
      },
    });
    const onContinue = vi.fn();
    render(<AccountInvitePage token="invite-token" onContinue={onContinue} />);

    expect(await screen.findByText("激活你的账号")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Updated User" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password-123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "设置密码并登录" }));

    await waitFor(() => expect(acceptAccountInvitation).toHaveBeenCalledWith("invite-token", {
      password: "password-123",
      displayName: "Updated User",
    }));
    expect(await screen.findByText("账号已激活")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "进入管理台" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("does not submit mismatched passwords", async () => {
    lookupAccountInvitation.mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        invitation: {
          email: "new-user@example.com",
          displayName: "New User",
          expiresAt: "2099-08-26T00:00:00.000Z",
        },
      },
    });
    render(<AccountInvitePage token="invite-token" onContinue={vi.fn()} />);

    await screen.findByText("激活你的账号");
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password-123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "password-456" } });
    fireEvent.click(screen.getByRole("button", { name: "设置密码并登录" }));

    expect(await screen.findByText("两次输入的密码不一致。")).toBeInTheDocument();
    expect(acceptAccountInvitation).not.toHaveBeenCalled();
  });

  it("shows an accepted invitation without a password form", async () => {
    lookupAccountInvitation.mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        invitation: {
          email: "new-user@example.com",
          displayName: "New User",
          expiresAt: "2099-08-26T00:00:00.000Z",
          acceptedAt: "2026-08-26T00:00:00.000Z",
        },
      },
    });
    render(<AccountInvitePage token="invite-token" onContinue={vi.fn()} />);

    expect(await screen.findByText(/该邀请已被接受/u)).toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  });
});
