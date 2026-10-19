import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n/react";
import { apiClient } from "../../api";
import type {
  KnowledgeDocument,
  KnowledgeDocumentPage,
  KnowledgeDocumentSummary,
  KnowledgeRepository,
  KnowledgeResult,
  KnowledgeSearchResult,
} from "@steamharness/knowledge-base";
import { DetailPage, getDetailNavItems } from "../DetailPage";
import type { DetailState, DetailTab } from "../../state";
import type { RelatedProjectStatus, Summary, VersionSummary } from "../../types";

type DetailPageProps = Parameters<typeof DetailPage>[0];

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.restoreAllMocks();
});

describe("DetailPage management tabs", () => {

  it.each(["workflow", "conversation", "kanban"] as const)("only exposes project, version and data tabs for %s", (projectType) => {
    const project = { ...createProject(), projectType };
    const navItems = getDetailNavItems(project);
    const tabKeys = navItems.map((item) => item.tab as string);
    expect(tabKeys).toEqual(["project", "settings", "members", "dependencies", "knowledge", "versions", "kv"]);
  });

  it("lets viewers inspect relations without requesting management data", async () => {
    vi.spyOn(apiClient, "listRelatedProjects").mockResolvedValue({
      errCode: 0, errMessage: "", data: { projectId: "demo", relatedProjects: [] },
    });
    const requests = vi.spyOn(apiClient, "listSourceAccessRequests");
    const projects = vi.spyOn(apiClient, "listProjects");
    renderDetailPage({ activeTab: "dependencies", project: { ...createProject(), canManage: false, canWriteData: false } });
    await screen.findByText("没有关联项目");
    expect(requests).not.toHaveBeenCalled();
    expect(projects).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "添加关联项目" })).toBeNull();
  });

  it("loads related projects, source access, and exact dependencies for a Kanban project", async () => {
    const relatedProjects = vi.spyOn(apiClient, "listRelatedProjects").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { projectId: "demo", relatedProjects: [] },
    });
    const getDependencies = vi.spyOn(apiClient, "getProjectDependencies").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { rootProjectId: "demo", rootVersion: "1.0.0", dependencies: [], publishable: true },
    });
    const listRequests = vi.spyOn(apiClient, "listSourceAccessRequests").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { requests: [], grants: [] },
    });
    const listProjects = vi.spyOn(apiClient, "listProjects").mockResolvedValue({ errCode: 0, errMessage: "", data: [] });

    renderDetailPage({
      activeTab: "dependencies",
      project: { ...createProject(), projectType: "kanban" },
    });

    await waitFor(() => expect(getDependencies).toHaveBeenCalledWith("demo", "latest"));
    expect(relatedProjects).toHaveBeenCalledWith("demo");
    expect(listRequests).toHaveBeenCalledWith("demo");
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "关联项目" })).toBeTruthy();
    expect(screen.getByText("当前项目版本依赖")).toBeTruthy();
  });

  it("loads generic relations without Kanban dependency status for a Workflow project", async () => {
    const getDependencies = vi.spyOn(apiClient, "getProjectDependencies");
    const relations = vi.spyOn(apiClient, "listRelatedProjects").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { projectId: "demo", relatedProjects: [] },
    });
    const listRequests = vi.spyOn(apiClient, "listSourceAccessRequests").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { requests: [], grants: [] },
    });
    const listProjects = vi.spyOn(apiClient, "listProjects").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: [],
    });

    renderDetailPage({ activeTab: "dependencies", project: createProject() });

    await waitFor(() => expect(relations).toHaveBeenCalledWith("demo"));
    expect(listRequests).toHaveBeenCalledWith("demo");
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(getDependencies).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "关联项目" })).toBeTruthy();
    expect(screen.getByText("项目关系")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
  });

  it("renders the latest Workflow dependency management page in English", async () => {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    vi.spyOn(apiClient, "listRelatedProjects").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { projectId: "demo", relatedProjects: [] },
    });
    vi.spyOn(apiClient, "listSourceAccessRequests").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { requests: [], grants: [] },
    });
    vi.spyOn(apiClient, "listProjects").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: [],
    });

    renderDetailPage({ activeTab: "dependencies", project: createProject() });

    expect(await screen.findByRole("heading", { name: "Related projects" })).toBeVisible();
    expect(screen.getByText("Project relationships")).toBeVisible();
    expect(screen.getByText("Source access requests")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add related project" })).toBeVisible();
  });

  it("keeps related projects loading until all management data resolves", async () => {
    let resolveRelations!: (value: Awaited<ReturnType<typeof apiClient.listRelatedProjects>>) => void;
    let resolveRequests!: (value: Awaited<ReturnType<typeof apiClient.listSourceAccessRequests>>) => void;
    vi.spyOn(apiClient, "listRelatedProjects").mockReturnValue(new Promise((resolve) => {
      resolveRelations = resolve;
    }));
    vi.spyOn(apiClient, "listSourceAccessRequests").mockReturnValue(new Promise((resolve) => {
      resolveRequests = resolve;
    }));
    vi.spyOn(apiClient, "listProjects").mockResolvedValue({ errCode: 0, errMessage: "", data: [] });

    renderDetailPage({ activeTab: "dependencies", project: createProject() });

    expect(screen.queryByText("没有关联项目")).toBeNull();

    resolveRelations({ errCode: 0, errMessage: "", data: { projectId: "demo", relatedProjects: [] } });
    resolveRequests({ errCode: 0, errMessage: "", data: { requests: [], grants: [] } });
    await waitFor(() => expect(screen.getByText("没有关联项目")).toBeTruthy());
  });

  it("distinguishes external delivery and only offers initialization for authorized sources", async () => {
    mockRelatedProjectManagement();
    vi.spyOn(apiClient, "getProjectDependencies").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: {
        rootProjectId: "demo",
        rootVersion: "1.0.0",
        publishable: false,
        dependencies: [{
          dependency: { alias: "external", projectId: "source-external", delivery: "external" },
          projectName: "外部来源",
          projectAvailable: true,
          sourceAvailable: true,
          sourceDownloadAllowed: true,
          relationshipConfirmed: true,
          dataInitialized: true,
        }, {
          dependency: { alias: "missing", projectId: "source-missing", delivery: "included", version: "1.0.0", sourceHash: "a".repeat(64) },
          projectName: "缺失来源",
          projectAvailable: false,
          sourceAvailable: false,
          sourceDownloadAllowed: false,
          relationshipConfirmed: false,
          dataInitialized: false,
        }, {
          dependency: { alias: "pending", projectId: "source-pending", delivery: "included", version: "1.0.0", sourceHash: "b".repeat(64) },
          projectName: "待确认来源",
          projectAvailable: true,
          sourceAvailable: true,
          sourceDownloadAllowed: true,
          relationshipConfirmed: false,
          dataInitialized: false,
        }, {
          dependency: { alias: "ready", projectId: "source-ready", delivery: "included", version: "1.0.0", sourceHash: "c".repeat(64) },
          projectName: "待初始化来源",
          projectAvailable: true,
          sourceAvailable: true,
          sourceDownloadAllowed: true,
          relationshipConfirmed: true,
          dataInitialized: false,
        }],
      },
    });

    renderDetailPage({ activeTab: "dependencies", project: { ...createProject(), projectType: "kanban" } });

    const externalRow = (await screen.findByText("外部来源")).closest("tr");
    expect(externalRow).not.toBeNull();
    expect(within(externalRow!).getByText("外部依赖")).toBeTruthy();
    expect(within(externalRow!).getByText("可下载")).toBeTruthy();
    expect(screen.getByText("项目已部署，Server 数据尚未初始化")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "打开来源项目" })).toHaveLength(3);
  });

  it("rejects invalid aliases before saving a related project", async () => {
    const targetProject = { ...createProject(), id: "11111111-1111-4111-8111-111111111111", name: "股票看板", projectType: "kanban" as const };
    mockRelatedProjectManagement({ projects: [createProject(), targetProject] });
    const saveRelation = vi.spyOn(apiClient, "setRelatedProject");
    renderDetailPage({ activeTab: "dependencies", project: createProject() });

    await screen.findByText("没有关联项目");
    fireEvent.click(screen.getByRole("button", { name: "添加关联项目" }));
    fireEvent.click(screen.getByRole("button", { name: "保存关联" }));

    expect(screen.getByText(/双方 alias 必须以小写字母开头/)).toBeTruthy();
    expect(saveRelation).not.toHaveBeenCalled();
  });

  it("creates both sides with explicit default read and write rules", async () => {
    const targetProject = { ...createProject(), id: "11111111-1111-4111-8111-111111111111", name: "股票看板", projectType: "kanban" as const };
    const otherProject = { ...createProject(), id: "22222222-2222-4222-8222-222222222222", name: "报表工具", projectType: "kanban" as const };
    mockRelatedProjectManagement({ projects: [createProject(), targetProject, otherProject] });
    const saveRelation = vi.spyOn(apiClient, "setRelatedProject").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { projectId: "demo", relatedProjects: [] },
    });

    renderDetailPage({ activeTab: "dependencies", project: createProject() });

    await screen.findByText("没有关联项目");
    fireEvent.click(screen.getByRole("button", { name: "添加关联项目" }));
    expect(screen.getByRole("heading", { name: "添加关联项目" })).toBeTruthy();
    expect(screen.queryByText(targetProject.id)).toBeNull();

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "目标关联项目" }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索关联目标项目" }), {
      target: { value: "股票" },
    });
    expect(screen.queryByRole("menuitemradio", { name: /报表工具/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /股票看板/ }));
    fireEvent.change(screen.getByLabelText("当前项目 alias"), { target: { value: "inventory" } });
    fireEvent.change(screen.getByLabelText("对方项目 alias"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "保存关联" }));

    await waitFor(() => expect(saveRelation).toHaveBeenCalledWith(
      "demo",
      "inventory",
      {
        targetProjectId: targetProject.id,
        targetAlias: "orders",
        grantToRelatedProject: { read: { mode: "all" }, write: { mode: "none" } },
        targetGrantToRelatedProject: { read: { mode: "all" }, write: { mode: "none" } },
      },
    ));
  });

  it("edits a confirmed relationship with a one-way prefix read grant", async () => {
    const targetProject = { ...createProject(), id: "11111111-1111-4111-8111-111111111111", name: "股票看板", projectType: "kanban" as const };
    const defaultGrant = { read: { mode: "all" as const }, write: { mode: "none" as const } };
    mockRelatedProjectManagement({
      projects: [createProject(), targetProject],
      relatedProjects: [{
        relation: { alias: "inventory", projectId: targetProject.id, grantToRelatedProject: defaultGrant },
        projectName: targetProject.name,
        reciprocalAlias: "orders",
        grantFromRelatedProject: defaultGrant,
        confirmed: true,
      }],
    });
    const saveRelation = vi.spyOn(apiClient, "setRelatedProject").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { projectId: "demo", relatedProjects: [] },
    });

    renderDetailPage({ activeTab: "dependencies", project: createProject() });

    const projectRow = (await screen.findByText("股票看板")).closest("tr");
    expect(projectRow).not.toBeNull();
    expect(within(projectRow!).getByText("已确认")).toBeTruthy();
    fireEvent.click(within(projectRow!).getByRole("button", { name: "编辑与 股票看板 的关系" }));

    expect(screen.getByRole("heading", { name: "编辑关联项目" })).toBeTruthy();
    const targetSelect = screen.getByRole("combobox", { name: "目标关联项目" });
    expect(targetSelect).toHaveProperty("disabled", true);
    const readSelectors = screen.getAllByRole("combobox", { name: "读取" });
    fireEvent.click(readSelectors[0]!);
    fireEvent.click(screen.getByRole("option", { name: "指定前缀" }));
    fireEvent.change(screen.getByLabelText("读取 key 前缀"), { target: { value: "stock.v1:\nreports.v1:" } });
    fireEvent.click(screen.getByRole("button", { name: "保存关联" }));

    await waitFor(() => expect(saveRelation).toHaveBeenCalledWith(
      "demo",
      "inventory",
      {
        targetProjectId: targetProject.id,
        targetAlias: "orders",
        grantToRelatedProject: { read: { mode: "prefixes", prefixes: ["stock.v1:", "reports.v1:"] }, write: { mode: "none" } },
        targetGrantToRelatedProject: defaultGrant,
      },
    ));
  });

  it("shows an unconfirmed relation without granting inbound KV access", async () => {
    const missingProjectId = "33333333-3333-4333-8333-333333333333";
    mockRelatedProjectManagement({
      projects: [],
      relatedProjects: [{
        relation: {
          alias: "inventory",
          projectId: missingProjectId,
          grantToRelatedProject: { read: { mode: "all" }, write: { mode: "none" } },
        },
        confirmed: false,
      }],
    });

    renderDetailPage({ activeTab: "dependencies", project: createProject() });

    expect(await screen.findByText("项目不可用")).toBeTruthy();
    expect(screen.getByText("待确认")).toBeTruthy();
    expect(screen.getByText("待对方确认")).toBeTruthy();
    expect(screen.getByText(missingProjectId)).toBeTruthy();
  });

  it("ignores a late dependency response after selecting another exact version", async () => {
    mockRelatedProjectManagement();
    let resolveLatest!: (value: Awaited<ReturnType<typeof apiClient.getProjectDependencies>>) => void;
    const latestResponse = new Promise<Awaited<ReturnType<typeof apiClient.getProjectDependencies>>>((resolve) => {
      resolveLatest = resolve;
    });
    const getDependencies = vi.spyOn(apiClient, "getProjectDependencies").mockImplementation((_projectId, target) => (
      target === "latest"
        ? latestResponse
        : Promise.resolve({
            errCode: 0,
            errMessage: "",
            data: {
              rootProjectId: "demo",
              rootVersion: target,
              publishable: true,
              dependencies: [{
                dependency: { alias: "current", projectId: "source-current", delivery: "external" },
                projectName: "当前版本来源",
                projectAvailable: true,
                sourceAvailable: true,
                sourceDownloadAllowed: true,
                relationshipConfirmed: true,
                dataInitialized: true,
              }],
            },
          })
    ));
    renderDetailPage({ activeTab: "dependencies", project: { ...createProject(), projectType: "kanban" } });

    await waitFor(() => expect(getDependencies).toHaveBeenCalledWith("demo", "latest"));
    fireEvent.click(screen.getByRole("combobox", { name: "依赖目标版本" }));
    fireEvent.click(screen.getByRole("option", { name: "1.0.0" }));
    await waitFor(() => expect(screen.getByText("当前版本来源")).toBeTruthy());

    resolveLatest({
      errCode: 0,
      errMessage: "",
      data: {
        rootProjectId: "demo",
        rootVersion: "1.0.0",
        publishable: true,
        dependencies: [{
          dependency: { alias: "late", projectId: "source-late", delivery: "external" },
          projectName: "迟到的旧响应",
          projectAvailable: true,
          sourceAvailable: true,
          sourceDownloadAllowed: true,
          relationshipConfirmed: true,
          dataInitialized: true,
        }],
      },
    });
    await Promise.resolve();

    expect(screen.getByText("当前版本来源")).toBeTruthy();
    expect(screen.queryByText("迟到的旧响应")).toBeNull();
  });

  it("resets the dependency target when the detail view switches projects", async () => {
    mockRelatedProjectManagement();
    const getDependencies = vi.spyOn(apiClient, "getProjectDependencies").mockResolvedValue({
      errCode: 0,
      errMessage: "",
      data: { rootProjectId: "demo", rootVersion: "latest", dependencies: [], publishable: true },
    });
    const firstProject = { ...createProject(), projectType: "kanban" as const };
    const view = renderDetailPage({ activeTab: "dependencies", project: firstProject });
    await waitFor(() => expect(getDependencies).toHaveBeenCalledWith("demo", "latest"));

    fireEvent.click(screen.getByRole("combobox", { name: "依赖目标版本" }));
    fireEvent.click(screen.getByRole("option", { name: "1.0.0" }));
    await waitFor(() => expect(getDependencies).toHaveBeenCalledWith("demo", "1.0.0"));

    const nextProject = {
      ...firstProject,
      id: "next-kanban",
      name: "Next Kanban",
      latest: "2.0.0",
      versions: ["2.0.0"],
    };
    view.rerender(createDetailPageElement({
      activeTab: "dependencies",
      project: nextProject,
      detail: createDetailState({
        versions: {
          ...createVersions(),
          id: "next-kanban",
          name: "Next Kanban",
          latest: "2.0.0",
          nextVersion: "2.0.1",
          versions: [{ ...createVersions().versions[0]!, version: "2.0.0" }],
        },
      }),
    }));

    await waitFor(() => expect(getDependencies).toHaveBeenCalledWith("next-kanban", "latest"));
    expect(screen.getByRole("combobox", { name: "依赖目标版本" }).textContent).toContain("latest");
  });

  it("loads generic related projects without Kanban dependencies for Conversation projects", async () => {
    const getDependencies = vi.spyOn(apiClient, "getProjectDependencies");
    const { listRelations, listRequests } = mockRelatedProjectManagement();

    renderDetailPage({
      activeTab: "dependencies",
      project: { ...createProject(), projectType: "conversation" },
    });
    await Promise.resolve();

    expect(getDependencies).not.toHaveBeenCalled();
    expect(listRelations).toHaveBeenCalledWith("demo");
    expect(listRequests).toHaveBeenCalledWith("demo");
    expect(await screen.findByRole("heading", { name: "关联项目" })).toBeTruthy();
  });

  it("uses Chinese project KV pagination and maps filter changes", () => {
    const onKVPageChange = vi.fn();
    const onKVFiltersChange = vi.fn();
    renderDetailPage({
      activeTab: "kv",
      detail: createDetailState({ kv: createKVPage({ total: 41, hasMore: true }) }),
      onKVPageChange,
      onKVFiltersChange,
    });

    const footer = screen.getAllByLabelText("分页页脚").at(-1);
    expect(footer).toBeTruthy();
    expect(within(footer as HTMLElement).getByText("每页行数:")).toBeTruthy();
    fireEvent.click(within(footer as HTMLElement).getByRole("button", { name: "下一页" }));
    expect(onKVPageChange).toHaveBeenCalledWith("next");

    const queryInput = screen.getAllByPlaceholderText("搜索 Key...").at(-1);
    expect(queryInput).toBeTruthy();
    fireEvent.change(queryInput as HTMLElement, { target: { value: "session" } });
    expect(onKVFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ query: "session" }));
  });

  it("renders knowledge documents through the shared repository and keeps mutations scoped", async () => {
    const onUpdate = vi.fn(async () => ({ errCode: 0, errMessage: "", data: createKnowledgeSummary() }));
    const onSearch = vi.fn();
    const onSearchMore = vi.fn();
    const onDelete = vi.fn(async () => ({ errCode: 0, errMessage: "", data: { id: createKnowledgeDocument().id, deleted: true } }));
    const onListMore = vi.fn();
    const page = { items: [createKnowledgeSummary()], nextCursor: "1", hasMore: true, total: 40 };
    const searchResult = createKnowledgeSearchResult();
    renderDetailPage({
      activeTab: "knowledge",
      knowledgeRepository: createKnowledgeRepository({ page, searchResult, onUpdate, onSearch, onSearchMore, onDelete, onListMore }),
    });

    const documentButton = await screen.findByRole("button", { name: "Guide" });
    expect(screen.queryByText("项目知识库")).toBeNull();
    // Summaries page through the repository's cursors instead of loading more
    // as the list is scrolled.
    expect(screen.getByText("第 1 / 2 页")).toBeTruthy();
    expect(screen.queryByText(createKnowledgeSummary().markdownPreview)).toBeNull();

    const documentList = screen.getByRole("region", { name: "知识库文档列表" });
    const documentBody = screen.getByRole("region", { name: "知识库文档主体" });
    expect(documentList.getAttribute("aria-label")).toBe("知识库文档列表");
    expect(documentBody.getAttribute("aria-label")).toBe("知识库文档主体");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(onListMore).toHaveBeenCalledTimes(1));

    fireEvent.click(documentButton);
    expect((await screen.findAllByRole("heading", { name: "Guide" })).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "# Guide\n\nUpdated knowledge." } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(createKnowledgeDocument().id, {
      title: "Guide",
      markdown: "# Guide\n\nUpdated knowledge.",
    }, expect.anything()));

    const searchInput = screen.getByRole("searchbox", { name: "搜索知识库文档" });
    fireEvent.change(searchInput, { target: { value: "persistent" } });
    fireEvent.submit(searchInput.closest("form") as HTMLFormElement);
    await screen.findByText("1 / 300 条");
    expect(onSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "persistent" }));
    fireEvent.click(screen.getByRole("button", { name: "加载更多结果" }));
    await waitFor(() => expect(onSearchMore).toHaveBeenCalledWith(expect.objectContaining({ cursor: "200" })));

    fireEvent.click(screen.getByRole("button", { name: "查看知识库信息" }));
    const infoDialog = screen.getByRole("dialog", { name: "知识库信息" });
    expect(within(infoDialog).getByText(createKnowledgeDocument().id)).toBeTruthy();
    expect(within(infoDialog).getByText(createKnowledgeSummary().markdownPreview)).toBeTruthy();
    expect(within(infoDialog).getByRole("button", { name: "关闭知识库信息" })).toBeTruthy();
    fireEvent.click(within(infoDialog).getByRole("button", { name: "关闭" }));

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除文档" })).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(createKnowledgeDocument().id, expect.anything()));
  });

  it("resets the shared knowledge workspace before a project switch can render stale documents", async () => {
    const secondPage = createDeferred<KnowledgeResult<KnowledgeDocumentPage>>();
    const firstProject = createProject();
    const secondProject = { ...createProject(), id: "other-project", name: "Other project" };
    const firstRepository = createKnowledgeRepository({
      page: {
        items: [{ ...createKnowledgeSummary(), id: "first-guide", title: "First guide" }],
        hasMore: false,
        total: 1,
      },
    });
    const secondRepository = createKnowledgeRepository({
      page: {
        items: [{ ...createKnowledgeSummary(), id: "second-guide", title: "Second guide" }],
        hasMore: false,
        total: 1,
      },
    });
    secondRepository.listDocuments = vi.fn(() => secondPage.promise);
    const view = renderDetailPage({
      activeTab: "knowledge",
      project: firstProject,
      knowledgeRepository: firstRepository,
    });

    expect(await screen.findByRole("button", { name: "First guide" })).toBeTruthy();
    view.rerender(createDetailPageElement({
      activeTab: "knowledge",
      project: secondProject,
      knowledgeRepository: secondRepository,
    }));

    expect(screen.queryByRole("button", { name: "First guide" })).toBeNull();
    expect(screen.getByRole("progressbar", { name: "正在加载知识库" })).toBeTruthy();
    secondPage.resolve({
      errCode: 0,
      errMessage: "",
      data: {
        items: [{ ...createKnowledgeSummary(), id: "second-guide", title: "Second guide" }],
        hasMore: false,
        total: 1,
      },
    });
    expect(await screen.findByRole("button", { name: "Second guide" })).toBeTruthy();
  });

  it("keeps knowledge actions in the document header and avoids rendering huge markdown previews", async () => {
    const document = { ...createKnowledgeDocument(), markdown: "x".repeat(200_001) };
    renderDetailPage({
      activeTab: "knowledge",
      knowledgeRepository: createKnowledgeRepository({ document }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("文档内容较大")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建文档" })).toBeTruthy();
    expect(screen.getByText(/切换到编辑模式查看/)).toBeTruthy();
  });

  it("resolves knowledge server file images before rendering markdown previews", async () => {
    const onResolveKnowledgeImageSrc = vi.fn().mockResolvedValue("blob:http://localhost/preview");
    const document = {
      ...createKnowledgeDocument(),
      markdown: "![0s 截图](/api/projects/files/wf_5043435afa7b49c9a6b9342a1b61c920)",
    };
    renderDetailPage({
      activeTab: "knowledge",
      knowledgeRepository: createKnowledgeRepository({ document }),
      onResolveKnowledgeImageSrc,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    await waitFor(() => {
      expect(screen.getByRole("img", { name: "0s 截图" }).getAttribute("src")).toBe("blob:http://localhost/preview");
    });
    expect(onResolveKnowledgeImageSrc).toHaveBeenCalledWith("/api/projects/files/wf_5043435afa7b49c9a6b9342a1b61c920");
  });

  it("keeps knowledge preview stable by deferring screenshot-heavy markdown images", async () => {
    const onResolveKnowledgeImageSrc = vi.fn().mockResolvedValue("blob:http://localhost/manual-preview");
    const heavyMarkdown = Array.from({ length: 49 }, (_, index) => `![${index}s 截图](/api/projects/files/wf_${index})`).join("\n\n");
    renderDetailPage({
      activeTab: "knowledge",
      knowledgeRepository: createKnowledgeRepository({ document: { ...createKnowledgeDocument(), markdown: heavyMarkdown } }),
      onResolveKnowledgeImageSrc,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByText("截图较多，预览已切换为稳定模式")).toBeTruthy();
    expect(screen.getByRole("button", { name: "加载 0s 截图" })).toBeTruthy();
    expect(onResolveKnowledgeImageSrc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "加载 0s 截图" }));
    await waitFor(() => {
      expect(screen.getByRole("img", { name: "0s 截图" }).getAttribute("src")).toBe("blob:http://localhost/manual-preview");
    });
    expect(onResolveKnowledgeImageSrc).toHaveBeenCalledWith("/api/projects/files/wf_0");
  });
});

type RenderOptions = {
  activeTab?: DetailTab;
  busy?: DetailPageProps["busy"];
  detail?: DetailState;
  onUpdateVisibility?: DetailPageProps["onUpdateVisibility"];
  onSetProjectMember?: DetailPageProps["onSetProjectMember"];
  onRemoveProjectMember?: DetailPageProps["onRemoveProjectMember"];
  onCreateProjectInvitation?: DetailPageProps["onCreateProjectInvitation"];
  onRevokeProjectInvitation?: DetailPageProps["onRevokeProjectInvitation"];
  onKVPageChange?: DetailPageProps["onKVPageChange"];
  onKVFiltersChange?: DetailPageProps["onKVFiltersChange"];
  onNavigateTab?: DetailPageProps["onNavigateTab"];
  onNavigateProjectTab?: DetailPageProps["onNavigateProjectTab"];
  project?: Summary;
  knowledgeRepository?: KnowledgeRepository;
  onResolveKnowledgeImageSrc?: DetailPageProps["onResolveKnowledgeImageSrc"];
};

function renderDetailPage(options: RenderOptions = {}) {
  return render(createDetailPageElement(options));
}

function createDetailPageElement(options: RenderOptions = {}) {
  const detail = options.detail ?? createDetailState();
  return (
    <DetailPage
      project={options.project ?? createProject()}
      detail={detail}
      activeTab={options.activeTab ?? "project"}
      busy={options.busy ?? {}}
      onUpdateVisibility={options.onUpdateVisibility ?? vi.fn()}
      onSetProjectMember={options.onSetProjectMember ?? vi.fn()}
      onRemoveProjectMember={options.onRemoveProjectMember ?? vi.fn()}
      onCreateProjectInvitation={options.onCreateProjectInvitation ?? vi.fn().mockResolvedValue(null)}
      onRevokeProjectInvitation={options.onRevokeProjectInvitation ?? vi.fn()}
      kvPageIndex={0}
      kvPageSize={20}
      kvFilters={{ query: "", scope: "all", valueType: "all", conversationId: "", runId: "" }}
      onKVFiltersChange={options.onKVFiltersChange ?? vi.fn()}
      onKVPageChange={options.onKVPageChange ?? vi.fn()}
      onLoadKVEntry={async (entry) => ({ errCode: 0, errMessage: "", data: { ...entry, value: { ok: true } } })}
      onDeleteKVEntry={async () => ({ errCode: 0, errMessage: "", data: { removed: true } })}
      knowledgeRepository={options.knowledgeRepository ?? createKnowledgeRepository()}
      knowledgeRefreshToken={0}
      onResolveKnowledgeImageSrc={options.onResolveKnowledgeImageSrc ?? ((src) => src)}
      onNavigateTab={options.onNavigateTab ?? vi.fn()}
      onNavigateProjectTab={options.onNavigateProjectTab ?? vi.fn()}
      sidebarCollapsed={false}
      onRefresh={vi.fn()}
    />
  );
}

function mockRelatedProjectManagement(options: {
  projects?: Summary[];
  relatedProjects?: RelatedProjectStatus[];
} = {}) {
  const listRelations = vi.spyOn(apiClient, "listRelatedProjects").mockResolvedValue({
    errCode: 0,
    errMessage: "",
    data: { projectId: "demo", relatedProjects: options.relatedProjects ?? [] },
  });
  const listProjects = vi.spyOn(apiClient, "listProjects").mockResolvedValue({
    errCode: 0,
    errMessage: "",
    data: options.projects ?? [],
  });
  const listRequests = vi.spyOn(apiClient, "listSourceAccessRequests").mockResolvedValue({
    errCode: 0,
    errMessage: "",
    data: { requests: [], grants: [] },
  });
  return { listRelations, listProjects, listRequests };
}

function createProject(): Summary {
  return {
    id: "demo",
    name: "Demo Project",
    projectType: "workflow", canManage: true, canWriteData: true,
    visibility: "private",
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
    versions: ["0.9.0", "1.0.0"],
    nextVersion: "1.0.1",
  };
}

function createDetailState(overrides: Partial<DetailState> = {}): DetailState {
  return {
    versions: createVersions(),
    members: [],
    invitations: [],
    kv: createKVPage(),
    ...overrides,
  };
}

function createVersions(): VersionSummary {
  return {
    id: "demo",
    name: "Demo Project",
    latest: "1.0.0",
    nextVersion: "1.0.1",
    totalDownloadCount: 0,
    versions: [
      {
        version: "1.0.0",
        downloadCount: 0,
        createdAt: "2026-05-26T00:00:00.000Z",
        createdByUserId: "publisher-1",
        createdByProfile: {
          userId: "publisher-1",
          displayName: "Version Publisher",
          email: "publisher@example.com",
        },
        releaseLog: "",
        latest: true,
        dependencies: [],
      },
      {
        version: "0.9.0",
        downloadCount: 0,
        createdAt: "2026-05-25T00:00:00.000Z",
        createdByUserId: "publisher-1",
        createdByProfile: {
          userId: "publisher-1",
          displayName: "Version Publisher",
          email: "publisher@example.com",
        },
        releaseLog: "previous",
        latest: false,
        dependencies: [],
      },
    ],
  };
}

function createKVPage(overrides: Partial<DetailState["kv"]> = {}) {
  return {
    total: 1,
    hasMore: false,
    items: [
      {
        storageKind: "kv" as const,
        scope: "project" as const,
        key: "session.cache",
        value: { ok: true },
        valueType: "object" as const,
        valueSizeBytes: 11,
        valuePreview: "{\"ok\":true}",
        projectId: "demo",
        updatedAt: "2026-05-26T11:26:25.000Z",
      },
    ],
    ...overrides,
  };
}

function createKnowledgeSummary() {
  return {
    id: createKnowledgeDocument().id,
    title: "Guide",
    markdownPreview: "PersistentValue knowledge with a long conversation id conversation_embed_a286d35e1c59b9c3_embed-local-b30b58101feb4cafb223f1ffd8733353.",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
  };
}

function createKnowledgeDocument() {
  return {
    id: "conversation.embed_a286d35e1c59b9c3_embed-local-b30b58101feb4cafb223f1ffd8733353.1dd2hm6",
    title: "Guide",
    markdown: "# Guide\n\nPersistentValue knowledge.",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
  };
}

function createKnowledgeSearchResult(): KnowledgeSearchResult {
  return {
    query: "persistent",
    documentsSearched: 1,
    totalMatches: 300,
    matchesTruncated: true,
    maxMatches: 200,
    pageSize: 200,
    nextCursor: "200",
    hasMore: true,
    matches: [{
      documentId: "guide",
      title: "Guide",
      lineNumber: 3,
      line: "PersistentValue knowledge.",
      before: [{ lineNumber: 2, content: "" }],
      after: [],
    }],
  };
}

function createKnowledgeRepository(options: {
  document?: KnowledgeDocument;
  page?: KnowledgeDocumentPage;
  searchResult?: KnowledgeSearchResult;
  onListMore?: (options: { cursor?: string }) => void;
  onSearch?: (options: { query: string }) => void;
  onSearchMore?: (options: { cursor?: string }) => void;
  onCreate?: (
    input: { id?: string; title: string; markdown: string },
    options: { signal?: AbortSignal },
  ) => Promise<KnowledgeResult<KnowledgeDocumentSummary | KnowledgeDocument>>;
  onUpdate?: (
    documentId: string,
    input: { title: string; markdown: string },
    options: { signal?: AbortSignal },
  ) => Promise<KnowledgeResult<KnowledgeDocumentSummary | KnowledgeDocument>>;
  onDelete?: (
    documentId: string,
    options: { signal?: AbortSignal },
  ) => Promise<KnowledgeResult<{ id: string; deleted: boolean }>>;
} = {}): KnowledgeRepository {
  const document = options.document ?? createKnowledgeDocument();
  const summary = createKnowledgeSummary();
  const page = options.page ?? { items: [summary], hasMore: false, total: 1 };
  const searchResult = options.searchResult ?? createKnowledgeSearchResult();
  return {
    async listDocuments(request) {
      if (request.cursor) {
        options.onListMore?.({ cursor: request.cursor });
        return { errCode: 0, errMessage: "", data: { ...page, hasMore: false, nextCursor: undefined } };
      }
      return { errCode: 0, errMessage: "", data: page };
    },
    async getDocument() {
      return { errCode: 0, errMessage: "", data: document };
    },
    async createDocument(input, request) {
      if (options.onCreate) return options.onCreate(input, request ?? {});
      return {
        errCode: 0,
        errMessage: "",
        data: { ...summary, id: input.id ?? document.id, title: input.title },
      };
    },
    async updateDocument(documentId, input, request) {
      if (options.onUpdate) return options.onUpdate(documentId, input, request ?? {});
      return {
        errCode: 0,
        errMessage: "",
        data: { ...summary, id: documentId, title: input.title },
      };
    },
    async deleteDocument(documentId, request) {
      if (options.onDelete) return options.onDelete(documentId, request ?? {});
      return { errCode: 0, errMessage: "", data: { id: documentId, deleted: true } };
    },
    async searchDocuments(request) {
      if (request.cursor) options.onSearchMore?.({ cursor: request.cursor });
      else options.onSearch?.({ query: request.query });
      return { errCode: 0, errMessage: "", data: searchResult };
    },
  };
}

function createDeferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T) => resolvePromise(value) };
}
