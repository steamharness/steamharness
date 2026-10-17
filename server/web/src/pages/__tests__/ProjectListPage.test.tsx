import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n";
import { ProjectListPage } from "../ProjectListPage";
import type { WorkflowSummary } from "../../types";

describe("ProjectListPage management table", () => {
  it("renders loading, empty, and searchable project rows without losing Chinese grid copy", () => {
    const { rerender } = renderProjectList({ projects: [], loading: "刷新项目" });

    // Default server/web tests must cover management page loading and
    // empty states, not only the storage helpers.
    expect(screen.getByRole("progressbar", { name: "正在加载表格" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("没有匹配的项目")).toBeNull();
    expect(screen.queryByText("No rows")).toBeNull();

    rerender(createProjectListElement({ projects: [] }));
    const emptyTitle = screen.getByText("没有匹配的项目");
    expect(emptyTitle).toBeTruthy();
    expect(emptyTitle.closest("[data-ui=table-empty-row]")).toBeTruthy();

    rerender(createProjectListElement());
    fireEvent.change(screen.getByPlaceholderText("搜索项目名称或版本..."), {
      target: { value: "beta" },
    });

    const table = screen.getByRole("table");
    expect(within(table).getByText("Beta Draft")).toBeTruthy();
    expect(within(table).queryByText("Alpha Workflow")).toBeNull();
  });

  it("renders project card kind and custom image metadata from uploaded packages", () => {
    renderProjectList({
      projects: [
        createProject({
          id: "conversation-demo",
          name: "Conversation Demo",
          projectType: "conversation",
          projectCard: {
            icon: "bot",
            iconUrl: "https://example.test/bot.png",
            iconColor: "#f8fafc",
            iconBackgroundColor: "#7c3aed",
          },
        }),
      ],
    });

    expect(screen.getByText("对话")).toBeTruthy();
    const image = screen.getByRole("img", { name: "Conversation Demo 图标" });
    expect(image.getAttribute("src")).toBe("https://example.test/bot.png");
    const projectIcon = screen.getByTestId("project-card-icon-conversation-demo");
    expect(projectIcon.style.backgroundColor).toBe("rgb(124, 58, 237)");
    expect(projectIcon.style.color).toBe("rgb(248, 250, 252)");
  });

  it("updates project type labels when the interface language changes", async () => {
    renderProjectList({
      projects: [createProject({
        id: "conversation-localized",
        name: "Conversation Localized",
        projectType: "conversation",
      })],
    });

    expect(screen.getByText("对话")).toBeTruthy();
    try {
      await act(async () => {
        await i18n.changeLanguage("en");
      });
      expect(screen.getByText("Conversation")).toBeTruthy();
    } finally {
      await act(async () => {
        await i18n.changeLanguage("zh-CN");
      });
    }
  });

  it("renders Kanban identity without offering run logs", () => {
    renderProjectList({
      projects: [createProject({
        id: "kanban-demo",
        name: "Product Board",
        projectType: "kanban",
      })],
    });

    const row = screen.getByText("Product Board").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("看板")).toBeTruthy();
    expect(within(row as HTMLElement).queryByRole("button", { name: "查看日志" })).toBeNull();
  });

  it("renders uploaded user display name and id in the projects table", () => {
    renderProjectList({
      projects: [
        createProject({
          id: "alpha",
          name: "Alpha Workflow",
          createdByUserId: "user-alpha",
          createdByProfile: {
            userId: "user-alpha",
            displayName: "Alice Uploader",
            email: "alice@example.com",
            avatarUrl: "https://example.test/alice.png",
          },
        }),
      ],
    });

    expect(screen.getByText("Alice Uploader")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByText("user-alpha")).toBeTruthy();
  });

  it("disables refresh while project files are loading", () => {
    renderProjectList({ loading: "projects" });
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
  });

  it("uses the shared uploader initials fallback when the profile image is missing", () => {
    renderProjectList({
      projects: [
        createProject({
          id: "beta",
          name: "Beta Workflow",
          createdByUserId: "user-beta",
          createdByProfile: {
            userId: "user-beta",
            displayName: "Beta Builder",
          },
        }),
      ],
    });

    expect(screen.getByText("Beta Builder")).toBeTruthy();
    expect(screen.getByText("user-beta")).toBeTruthy();
    expect(screen.getByText("BB")).toBeTruthy();
  });

  it("uses the shared uploader initials fallback when only the uploader id is recorded", () => {
    renderProjectList({
      projects: [
        createProject({
          id: "gamma",
          name: "Gamma Workflow",
          createdByUserId: "user-gamma",
        }),
      ],
    });

    const row = screen.getByText("Gamma Workflow").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getAllByText("user-gamma").length).toBeGreaterThan(0);
    expect(within(row as HTMLElement).getByText("UG")).toBeTruthy();
  });

  it("uses the shared Workflow glyph for default and legacy workflow icons", () => {
    renderProjectList({
      projects: [
        createProject({ id: "alpha", name: "Alpha Workflow" }),
        createProject({
          id: "legacy",
          name: "Legacy Workflow",
          projectCard: {
            icon: "sparkles",
            iconBackgroundColor: "#2563eb",
          },
        }),
      ],
    });

    expect(screen.getByTestId("project-card-icon-alpha").querySelector("svg")).toBeTruthy();
    expect(screen.getByTestId("project-card-icon-legacy").querySelector("svg")).toBeTruthy();
    expect(screen.getByTestId("project-card-icon-alpha").querySelector('img[src="/brand/steamharness-icon-mark.svg"]')).toBeNull();
    expect(screen.getByTestId("project-card-icon-legacy").querySelector('img[src="/brand/steamharness-icon-mark.svg"]')).toBeNull();
  });

  it("searches across project card kind labels", () => {
    renderProjectList({
      projects: [
        createProject({
          id: "conversation-demo",
          name: "Chat Runner",
          projectType: "conversation",
          projectCard: {
            icon: "message-circle",
            iconBackgroundColor: "#0f766e",
          },
        }),
        createProject({ id: "workflow-demo", name: "Build Runner" }),
      ],
    });

    fireEvent.change(screen.getByPlaceholderText("搜索项目名称或版本..."), {
      target: { value: "conversation" },
    });

    const table = screen.getByRole("table");
    expect(within(table).getByText("Chat Runner")).toBeTruthy();
    expect(within(table).queryByText("Build Runner")).toBeNull();
  });

  it("searches across uploaded user display names and email addresses", () => {
    renderProjectList({
      projects: [
        createProject({
          id: "alpha",
          name: "Alpha Workflow",
          createdByUserId: "user-alpha",
          createdByProfile: {
            userId: "user-alpha",
            displayName: "Alice Uploader",
          },
        }),
        createProject({
          id: "beta",
          name: "Beta Workflow",
          createdByUserId: "user-beta",
          createdByProfile: {
            userId: "user-beta",
            displayName: "Bob Publisher",
            email: "publisher@example.com",
          },
        }),
      ],
    });

    fireEvent.change(screen.getByPlaceholderText("搜索项目名称或版本..."), {
      target: { value: "publisher@example.com" },
    });

    const table = screen.getByRole("table");
    expect(within(table).getByText("Beta Workflow")).toBeTruthy();
    expect(within(table).queryByText("Alpha Workflow")).toBeNull();
  });

  it("sorts filtered projects by most recent update before pagination", () => {
    renderProjectList({
      projects: [
        createProject({ id: "oldest", name: "Oldest Project", updatedAt: "2026-05-01T00:00:00.000Z" }),
        createProject({ id: "unknown", name: "Unknown Update Project", updatedAt: undefined }),
        createProject({ id: "newest", name: "Newest Project", updatedAt: "2026-07-01T00:00:00.000Z" }),
        createProject({ id: "middle", name: "Middle Project", updatedAt: "2026-06-01T00:00:00.000Z" }),
      ],
    });

    const table = screen.getByRole("table");
    const projectNames = within(table).getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]?.textContent);

    expect(projectNames).toEqual([
      expect.stringContaining("Newest Project"),
      expect.stringContaining("Middle Project"),
      expect.stringContaining("Oldest Project"),
      expect.stringContaining("Unknown Update Project"),
    ]);
    expect(within(table).getByRole("columnheader", { name: "更新时间" }).getAttribute("aria-sort"))
      .toBe("descending");
  });

  it("paginates filtered projects in 20-row pages", () => {
    renderProjectList({
      projects: Array.from({ length: 21 }, (_, index) => createProject({
        id: `project-${index + 1}`,
        name: `Project ${index + 1}`,
      })),
    });

    // aligns all server/web management tables to 20 rows per page.
    const footer = screen.getByLabelText("分页页脚");
    expect(within(footer).getByText("每页行数:")).toBeTruthy();
    expect(within(footer).getByText("20")).toBeTruthy();
    expect(screen.getByText("Project 20")).toBeTruthy();
    expect(screen.queryByText("Project 21")).toBeNull();

    fireEvent.click(within(footer).getByRole("button", { name: "下一页" }));
    expect(screen.getByText("Project 21")).toBeTruthy();
    expect(screen.queryByText("Project 1")).toBeNull();
  });
});

type RenderProjectListOptions = {
  projects?: WorkflowSummary[];
  loading?: string;
  onOpenDetail?: (project: WorkflowSummary) => void;
  onOpenLogs?: (project: WorkflowSummary) => void;
};

function renderProjectList(options: RenderProjectListOptions = {}) {
  return render(createProjectListElement(options));
}

function createProjectListElement(options: RenderProjectListOptions = {}) {
  return (
    <ProjectListPage
      projects={options.projects ?? [
        createProject({ id: "alpha", name: "Alpha Workflow", latest: "1.0.0" }),
        createProject({ id: "beta", name: "Beta Draft", latest: null }),
      ]}
      selectedId=""
      loading={options.loading}
      onRefresh={vi.fn()}
      onOpenDetail={options.onOpenDetail ?? vi.fn()}
    />
  );
}

function createProject(overrides: Partial<WorkflowSummary>): WorkflowSummary {
  const serverRunnable = (overrides.projectType ?? "workflow") !== "kanban" && overrides.latest !== null;
  return {
    id: "demo",
    name: "Demo",
    projectType: "workflow",
    projectCard: {
      icon: "workflow",
      iconBackgroundColor: "#2563eb",
    },
    projectInfo: {
      localizedNames: {},
      declarations: [],
      platformSupport: { mode: "agnostic" },
      dataStorage: { mode: "server" },
      relatedProjects: [],
    },
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    hasDraft: false,
    latest: "1.0.0",
    versions: ["1.0.0"],
    nextVersion: "1.0.1",
    ...overrides,
  };
}
