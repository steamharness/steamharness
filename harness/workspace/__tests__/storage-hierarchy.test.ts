import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDeclaredWorkflowRelatedProjectKVResolver,
  createWorkflowKVContext,
  createWorkflowPersistentValueContext,
  createWorkflowRelatedProjectsContext,
  inspectLocalWorkflowStructure,
  readEntrypointOutput,
  runLocalWorkflowWithReport,
  type WorkflowExecutionReport,
  type WorkflowExecutionStorageOptions,
  type WorkflowKVStore,
  type WorkflowRelatedProjectResolverProject,
} from "steamharness";

type StorageLocation = "local" | "server";
type ProjectInfo = WorkflowRelatedProjectResolverProject["projectInfo"];

interface HierarchyProject {
  slug: string;
  projectId: string;
  projectInfo: ProjectInfo;
  location: StorageLocation;
}

interface StorageAccessOutput {
  action: "store" | "get";
  storageLocation: StorageLocation;
  target: "current" | "related";
  alias?: string;
  id: string;
  content?: unknown;
}

const STEAMHARNESS_ROOT = path.resolve(import.meta.dirname, "..", "workflow");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe.each(["local", "server"] as const)("%s data hierarchy", (location) => {
  it("declares only reciprocal parent-child and child-grandchild relationships", async () => {
    const hierarchy = await loadHierarchy(location);
    const parent = hierarchy.byRole.parent;
    const child = hierarchy.byRole.child;
    const grandchild = hierarchy.byRole.grandchild;

    expect(parent.projectInfo.dataStorage).toEqual({ mode: location });
    expect(child.projectInfo.dataStorage).toEqual({ mode: location });
    expect(grandchild.projectInfo.dataStorage).toEqual({ mode: location });
    expect(parent.projectInfo.relatedProjects.map((relation) => relation.alias)).toEqual(["child"]);
    expect(child.projectInfo.relatedProjects.map((relation) => relation.alias)).toEqual([
      "parent",
      "grandchild",
    ]);
    expect(grandchild.projectInfo.relatedProjects.map((relation) => relation.alias)).toEqual(["parent"]);

    assertReciprocalRelation(parent, "child", child);
    assertReciprocalRelation(child, "grandchild", grandchild);
    expect(parent.projectInfo.relatedProjects.some((relation) => relation.projectId === grandchild.projectId)).toBe(false);
    expect(grandchild.projectInfo.relatedProjects.some((relation) => relation.projectId === parent.projectId)).toBe(false);
  });

  it("exposes separate store and get entrypoints in every project", async () => {
    const hierarchy = await loadHierarchy(location);

    for (const project of Object.values(hierarchy.byRole)) {
      const structure = inspectLocalWorkflowStructure({
        workflowDir: path.join(STEAMHARNESS_ROOT, project.slug),
        workflowName: project.slug,
      });
      expect(structure.diagnostics.violations).toEqual([]);
      expect(structure.defaultEntrypoint).toBe("store");
      // The `note` entrypoint is what a *related* project calls: the local
      // hierarchy publishes it so the relation can be exercised end to end,
      // and the server hierarchy does not have one yet.
      const noteEntrypoint = project.slug === "local-data-parent"
        ? [{ id: "note", params: ["alias", "title", "markdown"] }]
        : project.slug === "local-data-child"
          ? [{ id: "note", params: ["title", "markdown"] }]
          : [];
      expect(structure.entrypoints?.map((entrypoint) => ({
        id: entrypoint.id,
        params: entrypoint.params?.map((param) => param.name),
      }))).toEqual([
        { id: "store", params: ["content", "alias"] },
        { id: "get", params: ["id", "alias"] },
        ...noteEntrypoint,
      ]);
    }
  });

  it("stores content under generated ids and isolates current-project values", async () => {
    const runner = await createHierarchyRunner(location);
    const parentContent = `  ${location}-parent\nline 2  `;

    const parentStored = readOutput(await runner.run("parent", "store", {
      content: parentContent,
    }));
    const childStored = readOutput(await runner.run("child", "store", {
      content: `${location}-child`,
    }));
    expect(parentStored.id).toMatch(UUID_PATTERN);
    expect(childStored.id).toMatch(UUID_PATTERN);
    expect(childStored.id).not.toBe(parentStored.id);
    expect(readOutput(await runner.run("parent", "get", { id: parentStored.id })).content)
      .toBe(parentContent);
    expect(readOutput(await runner.run("child", "get", { id: childStored.id })).content)
      .toBe(`${location}-child`);
    expect((await runner.run("child", "get", { id: parentStored.id })).status).toBe("failed");
    expect((await runner.run("parent", "get", { id: childStored.id })).status).toBe("failed");
    expect(runner.fallbackStore.values.size).toBe(0);
  });

  it("allows store and get in both directions on direct relationships", async () => {
    const runner = await createHierarchyRunner(location);

    const parentToChild = readOutput(await runner.run("parent", "store", {
      alias: "child",
      content: `${location}-parent-to-child`,
    }));
    expect(readOutput(await runner.run("child", "get", { id: parentToChild.id })).content)
      .toBe(`${location}-parent-to-child`);

    const childToParent = readOutput(await runner.run("child", "store", {
      alias: "parent",
      content: `${location}-child-to-parent`,
    }));
    expect(readOutput(await runner.run("parent", "get", { id: childToParent.id })).content)
      .toBe(`${location}-child-to-parent`);

    const childToGrandchild = readOutput(await runner.run("child", "store", {
      alias: "grandchild",
      content: `${location}-child-to-grandchild`,
    }));
    expect(readOutput(await runner.run("grandchild", "get", { id: childToGrandchild.id })).content)
      .toBe(`${location}-child-to-grandchild`);

    const grandchildToChild = readOutput(await runner.run("grandchild", "store", {
      alias: "parent",
      content: `${location}-grandchild-to-child`,
    }));
    expect(readOutput(await runner.run("child", "get", { id: grandchildToChild.id })).content)
      .toBe(`${location}-grandchild-to-child`);

    const childCurrent = readOutput(await runner.run("child", "store", {
      content: `${location}-child-current`,
    }));
    expect(readOutput(await runner.run("parent", "get", {
      alias: "child",
      id: childCurrent.id,
    })).content).toBe(`${location}-child-current`);
    expect(runner.fallbackStore.values.size).toBe(0);
  });

  it("rejects parent-grandchild access because related KV never traverses two hops", async () => {
    const runner = await createHierarchyRunner(location);
    const parentToGrandchild = await runner.run("parent", "get", {
      alias: "grandchild",
      id: "blocked",
    });
    const grandchildToParent = await runner.run("grandchild", "get", {
      alias: "grandparent",
      id: "blocked",
    });

    expect(parentToGrandchild.status).toBe("failed");
    expect(grandchildToParent.status).toBe("failed");
    expect(JSON.stringify(parentToGrandchild.result)).toContain("unavailable or awaiting confirmation");
    expect(JSON.stringify(grandchildToParent.result)).toContain("unavailable or awaiting confirmation");
    expect(runner.fallbackStore.values.size).toBe(0);
  });

  it.runIf(location === "local")("reaches a related project's knowledge base and entrypoints", async () => {
    const runner = await createHierarchyRunner(location);
    const parent = runner.relatedProjectsFor("parent");

    // The grant names one entrypoint, so that is the whole list — and the
    // target's other entrypoints are refused rather than merely hidden.
    expect((await parent.get("child").listEntrypoints()).map((entrypoint) => entrypoint.id))
      .toEqual(["note"]);
    await expect(parent.get("child").runEntrypoint("store", ["--content", "x"]))
      .rejects.toThrow(/does not grant this project access to entrypoint "store"/);

    const noted = readNoteOutput(await runner.run("parent", "note", {
      alias: "child",
      title: "运行手册",
      markdown: "# 运行手册\n\n先重启采集器。",
    }));
    expect(noted.alias).toBe("child");
    expect(noted.documentId).not.toBe("");
    expect(noted.relatedDocuments).toBe(1);
    expect(noted.content).toContain("先重启采集器");

    // The document landed in the child's knowledge base — the store the child
    // reads when it runs as itself — and two hops away is not part of this.
    expect((await parent.get("child").knowledge.listDocuments()).items).toHaveLength(1);
    await expect(parent.get("grandchild").knowledge.listDocuments())
      .rejects.toThrow(/unavailable or awaiting confirmation/);
  });
});

async function createHierarchyRunner(location: StorageLocation) {
  const hierarchy = await loadHierarchy(location);
  const selectedStore = createMemoryKVStore();
  const fallbackStore = createMemoryKVStore();
  const persistentValueStore = createMemoryKVStore();
  const projectsById = new Map(
    Object.values(hierarchy.byRole).map((project) => [project.projectId, project]),
  );

  /** Runs a related project's entrypoint the way a host does: its own code, its own store. */
  function createTargetRunner(target: HierarchyProject) {
    return {
      async listEntrypoints() {
        const structure = inspectLocalWorkflowStructure({
          workflowDir: path.join(STEAMHARNESS_ROOT, target.slug),
          workflowName: target.slug,
        });
        return (structure.entrypoints ?? []).map((entrypoint) => ({
          id: entrypoint.id,
          title: entrypoint.title,
          description: entrypoint.description,
        }));
      },
      async run(entrypointId: string, args: readonly string[]): Promise<unknown> {
        const report = await runLocalWorkflowWithReport({
          workflowDir: path.join(STEAMHARNESS_ROOT, target.slug),
          workflowName: target.slug,
          entrypointId,
          args: [...args],
          // No related resolver travels into it, which is what keeps a
          // relation direct: the project reached this way cannot reach a third
          // one through itself.
          storage: {
            host: location,
            [location]: { kvStore: selectedStore, persistentValueStore },
          },
        });
        // The unwrapper is also the failure check: a run that failed comes
        // back as an envelope whose errCode it raises, so the caller sees the
        // entrypoint's own message instead of a null payload.
        return readEntrypointOutput(report.result.data);
      },
    };
  }

  function createResolver(consumer: HierarchyProject) {
    return createDeclaredWorkflowRelatedProjectKVResolver({
      getConsumerProject: () => ({
        projectId: consumer.projectId,
        projectInfo: consumer.projectInfo,
      }),
      getTargetProject(projectId) {
        const target = projectsById.get(projectId);
        return target === undefined
          ? undefined
          : {
              projectId: target.projectId,
              projectInfo: target.projectInfo,
              kv: createWorkflowKVContext({
                store: selectedStore,
                projectId: target.projectId,
              }),
              persistentValue: createWorkflowPersistentValueContext({
                store: persistentValueStore,
                projectId: target.projectId,
              }),
              runner: createTargetRunner(target),
            };
      },
    });
  }

  async function run(
    role: keyof typeof hierarchy.byRole,
    entrypoint: "store" | "get" | "note",
    input: { alias?: string; id?: string; content?: string; title?: string; markdown?: string },
  ): Promise<WorkflowExecutionReport> {
    const project = hierarchy.byRole[role];
    const selectedBackend = {
      kvStore: selectedStore,
      relatedProjectResolver: createResolver(project),
    };
    const fallbackBackend = { kvStore: fallbackStore };
    const storage: WorkflowExecutionStorageOptions = location === "local"
      ? { host: "local", local: selectedBackend, server: fallbackBackend }
      : { host: "server", local: fallbackBackend, server: selectedBackend };
    const args: string[] = [];
    if (input.alias !== undefined) args.push("--alias", input.alias);
    if (input.title !== undefined) args.push("--title", input.title);
    if (input.markdown !== undefined) args.push("--markdown", input.markdown);
    if (input.id !== undefined) args.push("--id", input.id);
    if (input.content !== undefined) args.push("--content", input.content);

    return runLocalWorkflowWithReport({
      workflowDir: path.join(STEAMHARNESS_ROOT, project.slug),
      workflowName: project.slug,
      entrypointId: entrypoint,
      args,
      storage,
    });
  }

  return {
    run,
    fallbackStore,
    /** One project's related-project surface, for assertions the workflows cannot make. */
    relatedProjectsFor(role: keyof typeof hierarchy.byRole) {
      return createWorkflowRelatedProjectsContext(createResolver(hierarchy.byRole[role]));
    },
  };
}

async function loadHierarchy(location: StorageLocation) {
  const entries = await Promise.all(
    (["parent", "child", "grandchild"] as const).map(async (role) => {
      const slug = `${location}-data-${role}`;
      const packageJson = JSON.parse(
        await readFile(path.join(STEAMHARNESS_ROOT, slug, "package.json"), "utf8"),
      ) as {
        id: string;
        steamHarness: { projectInfo: ProjectInfo };
      };
      return [role, {
        slug,
        projectId: packageJson.id,
        projectInfo: packageJson.steamHarness.projectInfo,
        location,
      } satisfies HierarchyProject] as const;
    }),
  );
  return { byRole: Object.fromEntries(entries) as Record<(typeof entries)[number][0], HierarchyProject> };
}

function assertReciprocalRelation(
  source: HierarchyProject,
  sourceAlias: string,
  target: HierarchyProject,
): void {
  const forward = source.projectInfo.relatedProjects.find((relation) => relation.alias === sourceAlias);
  const reverse = target.projectInfo.relatedProjects.find((relation) => relation.projectId === source.projectId);
  expect(forward?.projectId).toBe(target.projectId);
  expect(reverse).toBeDefined();
  // The KV grant is what makes a relation work at all; a project is free to
  // grant more on top of it (the local child publishes an entrypoint and its
  // knowledge base to its parent), and that is asserted where it is used.
  expect(forward?.grantToRelatedProject).toMatchObject({
    read: { mode: "all" },
    write: { mode: "all" },
  });
  expect(reverse?.grantToRelatedProject).toMatchObject({
    read: { mode: "all" },
    write: { mode: "all" },
  });
}

interface NoteAccessOutput {
  action: "note";
  alias: string;
  documentId: string;
  relatedDocuments: number;
  content?: string;
}

function readNoteOutput(report: WorkflowExecutionReport): NoteAccessOutput {
  expect(report.status).toBe("success");
  expect(report.result.ok).toBe(true);
  if (!report.result.ok) throw new Error("Expected workflow execution to succeed.");
  return readEntrypointOutput(report.result.data) as NoteAccessOutput;
}

function readOutput(report: WorkflowExecutionReport): StorageAccessOutput {
  expect(report.status).toBe("success");
  expect(report.result.ok).toBe(true);
  if (!report.result.ok) throw new Error("Expected workflow execution to succeed.");
  const data = report.result.data as {
    errCode: number;
    errMessage: string;
    output: StorageAccessOutput;
  };
  expect(data.errCode).toBe(0);
  expect(data.errMessage).toBe("");
  return data.output;
}

function createMemoryKVStore(): WorkflowKVStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const createKey = (input: {
    storageKind: string;
    scope: string;
    projectId: string;
    conversationId?: string;
    key: string;
  }) => [input.storageKind, input.scope, input.projectId, input.conversationId ?? "", input.key].join(":");

  return {
    values,
    // A real local store can hold a namespace lock; knowledge mutations need
    // one (or a mutation executor) and refuse without either.
    async withNamespaceLock<T>(_scope: unknown, operation: () => Promise<T> | T): Promise<T> {
      return operation();
    },
    async withNamespaceReadLock<T>(_scope: unknown, operation: () => Promise<T> | T): Promise<T> {
      return operation();
    },
    async getValue(input) {
      return values.get(createKey(input));
    },
    async setValue(input) {
      values.set(createKey(input), input.value);
    },
    async updateValue(input, updater) {
      const key = createKey(input);
      const next = updater(values.get(key));
      values.set(key, next);
      return next;
    },
  };
}
