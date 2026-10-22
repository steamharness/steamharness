import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n/react";
import { apiClient } from "../../api";
import { ProjectSourceAccessRequestPage } from "../ProjectSourceAccessRequestPage";

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.restoreAllMocks();
});

describe("ProjectSourceAccessRequestPage", () => {
  it("loads the signed project link and submits one source access request", async () => {
    const getLink = vi.spyOn(apiClient, "getProjectSourceAccessLink").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        projectId: "00000000-0000-4000-8000-000000000001",
        projectName: "股票数据库",
      },
    });
    const createRequest = vi.spyOn(apiClient, "createProjectSourceAccessRequest").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        id: "00000000-0000-4000-8000-000000000002",
        projectId: "00000000-0000-4000-8000-000000000001",
        requesterUserId: "viewer-1",
        reason: "下载股票看板引用的 Workflow",
        status: "pending",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
    });

    render(
      <ProjectSourceAccessRequestPage
        token="signed-token"
        onNavigateProjects={vi.fn()}
      />,
    );

    expect(screen.getByText("正在校验申请链接")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("申请项目访问")).toBeTruthy());
    expect(getLink).toHaveBeenCalledWith("signed-token");

    fireEvent.change(screen.getByLabelText("申请原因"), {
      target: { value: "  下载股票看板引用的 Workflow  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

    await waitFor(() => expect(createRequest).toHaveBeenCalledWith(
      "signed-token",
      "下载股票看板引用的 Workflow",
    ));
    expect(screen.getByText("申请已提交")).toBeTruthy();
    expect(screen.getByText("当前状态：等待审批")).toBeTruthy();
  });

  it("renders the source access flow in English", async () => {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    vi.spyOn(apiClient, "getProjectSourceAccessLink").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        projectId: "00000000-0000-4000-8000-000000000001",
        projectName: "Stock Database",
      },
    });

    render(
      <ProjectSourceAccessRequestPage
        token="signed-token"
        onNavigateProjects={vi.fn()}
      />,
    );

    expect(screen.getByText("Checking access request link")).toBeVisible();
    expect(await screen.findByText("Request project access")).toBeVisible();
    expect(screen.getByLabelText("Reason for request")).toBeVisible();
    expect(screen.getByRole("button", { name: "Submit request" })).toBeVisible();
  });
});
