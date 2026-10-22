import { resolveResourceAccess } from "@steamharness/project-access";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetailPageProps } from "../types";
import { KnowledgeTab } from "../KnowledgeTab";
import type { Summary } from "../../../types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KnowledgeTab server image lifecycle", () => {
  it("lets viewers read documents without exposing mutation controls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("?pageSize=20")) return Promise.resolve(successResponse(createPage("Read-only guide")));
      if (url.endsWith("/guide")) return Promise.resolve(successResponse({
        ...createDocument("Read-only guide"), markdown: "Visible to viewers.",
      }));
      throw new Error(`Unexpected request: ${url}`);
    });
    renderKnowledgeTab({ ...createProject("project-a", "Project A"), access: resolveResourceAccess([{type:"project",id:"demo",role:"guest"}]) });
    fireEvent.click(await screen.findByRole("button", { name: "Read-only guide" }));
    expect(await screen.findByText("Visible to viewers.")).toBeTruthy();
    for (const name of ["新建文档", "编辑", "保存", "删除"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(fetchSpy.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("aborts project-scoped image requests and revokes late blob URLs after a project switch", async () => {
    const lateFileResponse = createDeferred<Response>();
    let lateFileSignal: AbortSignal | undefined;
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late-project-a-image");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const path = String(input);
      if (path === "/api/projects/project-a/knowledge-documents?pageSize=20") {
        return Promise.resolve(successResponse(createPage("Guide A")));
      }
      if (path === "/api/projects/project-a/knowledge-documents/guide") {
        return Promise.resolve(successResponse(createDocument("Guide A")));
      }
      if (path === "/api/projects/files/wf-project-a-image") {
        lateFileSignal = init?.signal as AbortSignal | undefined;
        return lateFileResponse.promise;
      }
      if (path === "/api/projects/project-b/knowledge-documents?pageSize=20") {
        return Promise.resolve(successResponse({ items: [], hasMore: false, total: 0 }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const view = renderKnowledgeTab(createProject("project-a", "Project A"));
    fireEvent.click(await screen.findByRole("button", { name: "Guide A" }));
    await waitFor(() => expect(lateFileSignal).toBeDefined());

    view.rerender(createKnowledgeTabElement(createProject("project-b", "Project B")));

    await waitFor(() => expect(lateFileSignal?.aborted).toBe(true));
    await act(async () => {
      lateFileResponse.resolve(imageResponse());
      await Promise.resolve();
    });

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:late-project-a-image");
  });

  it("releases active image blob URLs when the knowledge tab unmounts", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:active-project-image");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const path = String(input);
      if (path === "/api/projects/project-a/knowledge-documents?pageSize=20") {
        return Promise.resolve(successResponse(createPage("Guide A")));
      }
      if (path === "/api/projects/project-a/knowledge-documents/guide") {
        return Promise.resolve(successResponse(createDocument("Guide A")));
      }
      if (path === "/api/projects/files/wf-project-a-image") {
        return Promise.resolve(imageResponse());
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const view = renderKnowledgeTab(createProject("project-a", "Project A"));
    fireEvent.click(await screen.findByRole("button", { name: "Guide A" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    view.unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:active-project-image");
  });

  it("reports unsaved shared-editor drafts to the detail navigation host", async () => {
    const onKnowledgeDirtyChange = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const path = String(input);
      if (path === "/api/projects/project-a/knowledge-documents?pageSize=20") {
        return Promise.resolve(successResponse(createPage("Guide A")));
      }
      if (path === "/api/projects/project-a/knowledge-documents/guide") {
        return Promise.resolve(successResponse({
          id: "guide",
          title: "Guide A",
          markdown: "# Guide A\n\nDraft body.",
          createdAt: "2026-07-13T00:00:00.000Z",
          updatedAt: "2026-07-13T00:00:00.000Z",
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const view = render(createKnowledgeTabElement(createProject("project-a", "Project A"), { onKnowledgeDirtyChange }));
    fireEvent.click(await screen.findByRole("button", { name: "Guide A" }));
    expect(await screen.findByText("Draft body.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "# Guide A\n\nUnsaved body." } });

    await waitFor(() => expect(onKnowledgeDirtyChange).toHaveBeenLastCalledWith(true));
    view.unmount();
    expect(onKnowledgeDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

function renderKnowledgeTab(project: Summary) {
  return render(createKnowledgeTabElement(project));
}

function createKnowledgeTabElement(project: Summary, overrides: Partial<DetailPageProps> = {}) {
  return <KnowledgeTab {...({ project, knowledgeRefreshToken: 0, ...overrides } as DetailPageProps)} />;
}

function createProject(id: string, name: string): Summary {
  return {
    id,
    name,
    projectType: "workflow", access: resolveResourceAccess([{type:"project",id:"demo",role:"owner"}]),
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
    visibility: "private",
    hasDraft: false,
    latest: "1.0.0",
    versions: ["1.0.0"],
    nextVersion: "1.0.1",
  };
}

function createPage(title: string) {
  return {
    items: [{
      id: "guide",
      title,
      markdownPreview: "Preview",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    }],
    hasMore: false,
    total: 1,
  };
}

function createDocument(title: string) {
  return {
    id: "guide",
    title,
    markdown: "![Project image](/api/projects/files/wf-project-a-image)",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function successResponse(data: unknown): Response {
  return new Response(JSON.stringify({ errCode: 0, errMessage: "", data }));
}

function imageResponse(): Response {
  return new Response("image", { headers: { "Content-Type": "image/png" } });
}

function createDeferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T) => resolvePromise(value) };
}
