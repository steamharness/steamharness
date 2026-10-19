import { describe, expect, it } from "vitest";
import {
  assertProjectDataStorageLocationAllowed,
  assertProjectRelatedProjects,
  createDefaultProjectRelatedProjectGrant,
  createDefaultProjectInfo,
  createUndeclaredProjectInfo,
  isProjectAccessAllowed,
  isProjectKVAccessAllowed,
  isProjectDataStorageLocationAllowed,
  listProjectSearchNames,
  matchesProjectSearch,
  normalizeDeclaredProjectInfoInput,
  normalizeProjectInfo,
  readProjectInfo,
  resolveProjectRelatedProjectAccess,
  resolveProjectName,
  serializeProjectInfo,
  writeProjectInfo,
} from "../index";

describe("workflow project info", () => {
  it("keeps legacy packages undeclared while new projects default to both stores", () => {
    expect(readProjectInfo({ name: "Legacy" })).toEqual(createUndeclaredProjectInfo());
    expect(createDefaultProjectInfo().dataStorage).toEqual({ mode: "both" });
  });

  it("normalizes names and preserves future declaration and platform ids", () => {
    expect(normalizeProjectInfo({
      localizedNames: { "zh-CN": " 中文名称 ", en: "English Name", ja: "日本語", empty: " " },
      declarations: ["multilingual", "future-capability", "multilingual"],
      platformSupport: { mode: "specific", platforms: ["macos", "future-os", "macos"] },
      dataStorage: { mode: "server" },
    })).toEqual({
      localizedNames: { "zh-CN": "中文名称", en: "English Name", ja: "日本語" },
      declarations: ["multilingual", "future-capability"],
      platformSupport: { mode: "specific", platforms: ["macos", "future-os"] },
      dataStorage: { mode: "server" },
      relatedProjects: [],
    });
  });

  it("requires a declared storage mode for strict writes", () => {
    expect(normalizeProjectInfo({}).dataStorage).toBeNull();
    expect(() => normalizeDeclaredProjectInfoInput({})).toThrow("must be declared");
    expect(() => normalizeProjectInfo({ dataStorage: { mode: "remote" } }))
      .toThrow('must be "local", "server", or "both"');
  });

  it("enforces local and server storage locations", () => {
    const local = normalizeDeclaredProjectInfoInput({ dataStorage: { mode: "local" } });
    const both = normalizeDeclaredProjectInfoInput({ dataStorage: { mode: "both" } });
    expect(isProjectDataStorageLocationAllowed(local, "local")).toBe(true);
    expect(isProjectDataStorageLocationAllowed(local, "server")).toBe(false);
    expect(isProjectDataStorageLocationAllowed(both, "server")).toBe(true);
    expect(() => assertProjectDataStorageLocationAllowed(local, "server"))
      .toThrow("does not allow server storage access");
    expect(() => assertProjectDataStorageLocationAllowed(
      createUndeclaredProjectInfo(),
      "local",
    )).toThrow("must be declared before this project can run");
  });

  it("rejects agnostic and explicit platform combinations", () => {
    expect(() => normalizeProjectInfo({
      platformSupport: { mode: "agnostic", platforms: [] },
    })).toThrow("not allowed in agnostic mode");
    expect(() => normalizeProjectInfo({
      platformSupport: { mode: "specific", platforms: [] },
    })).toThrow("must contain at least one platform");
  });

  it("resolves locale names and indexes every localized name", () => {
    const info = normalizeProjectInfo({
      localizedNames: { "zh-CN": "中文名称", en: "English Name" },
      declarations: [],
      platformSupport: { mode: "agnostic" },
      dataStorage: { mode: "both" },
    });
    expect(resolveProjectName("Default Name", info, "zh-Hans")).toBe("中文名称");
    expect(resolveProjectName("Default Name", info, "en-US")).toBe("English Name");
    expect(resolveProjectName("Default Name", info, "fr")).toBe("Default Name");
    expect(listProjectSearchNames("Default Name", info)).toEqual([
      "Default Name",
      "中文名称",
      "English Name",
    ]);
    expect(matchesProjectSearch("Default Name", info, "english")).toBe(true);
    expect(matchesProjectSearch("Default Name", info, "中文")).toBe(true);
  });

  it("writes project info without changing other steamHarness fields", () => {
    expect(writeProjectInfo({
      name: "Default",
      steamHarness: { projectType: "workflow", future: true },
    }, {
      localizedNames: { en: "English" },
      declarations: ["multilingual"],
      platformSupport: { mode: "specific", platforms: ["web"] },
      dataStorage: { mode: "server" },
      relatedProjects: [],
    })).toEqual({
      name: "Default",
      steamHarness: {
        projectType: "workflow",
        future: true,
        projectInfo: {
          localizedNames: { en: "English" },
          declarations: ["multilingual"],
          platformSupport: { mode: "specific", platforms: ["web"] },
          dataStorage: { mode: "server" },
          relatedProjects: [],
        },
      },
    });
  });

  it("normalizes related projects and resolves reciprocal access", () => {
    const consumerId = "11111111-1111-4111-8111-111111111111";
    const targetId = "22222222-2222-4222-8222-222222222222";
    const consumer = normalizeProjectInfo({
      dataStorage: { mode: "both" },
      relatedProjects: [{
        alias: "inventory",
        projectId: targetId,
        grantToRelatedProject: createDefaultProjectRelatedProjectGrant(),
      }],
    });
    const target = normalizeProjectInfo({
      dataStorage: { mode: "both" },
      relatedProjects: [{
        alias: "orders",
        projectId: consumerId,
        grantToRelatedProject: {
          read: { mode: "prefixes", prefixes: ["catalog:"] },
          write: { mode: "none" },
        },
      }],
    });

    expect(resolveProjectRelatedProjectAccess({
      consumerProjectId: consumerId,
      consumerProjectInfo: consumer,
      targetProjectId: targetId,
      targetProjectInfo: target,
      alias: "inventory",
    })?.grant).toEqual({
      read: { mode: "prefixes", prefixes: ["catalog:"] },
      write: { mode: "none" },
    });
    expect(isProjectKVAccessAllowed(
      target.relatedProjects[0]!.grantToRelatedProject.read,
      "catalog:item",
    )).toBe(true);
    expect(isProjectKVAccessAllowed(
      target.relatedProjects[0]!.grantToRelatedProject.read,
      "private:item",
    )).toBe(false);
  });

  it("keeps one-sided relations pending and validates relationship declarations", () => {
    const consumerId = "11111111-1111-4111-8111-111111111111";
    const targetId = "22222222-2222-4222-8222-222222222222";
    const consumer = normalizeProjectInfo({
      relatedProjects: [{
        alias: "target",
        projectId: targetId,
        grantToRelatedProject: createDefaultProjectRelatedProjectGrant(),
      }],
    });
    expect(resolveProjectRelatedProjectAccess({
      consumerProjectId: consumerId,
      consumerProjectInfo: consumer,
      targetProjectId: targetId,
      targetProjectInfo: normalizeProjectInfo({}),
      alias: "target",
    })).toBeUndefined();
    expect(() => assertProjectRelatedProjects(consumer, targetId)).toThrow("current project");
  });

  it("leaves knowledge and entrypoints closed for a manifest that predates them", () => {
    // The whole point of the two new fields being optional: a project that
    // already let another read its KV did not agree to hand over its knowledge
    // base or let it run its entrypoints, and nothing about this change may
    // read as if it had.
    const relation = normalizeProjectInfo({
      relatedProjects: [{
        alias: "database",
        projectId: "22222222-2222-4222-8222-222222222222",
        grantToRelatedProject: { read: { mode: "all" }, write: { mode: "all" } },
      }],
    }).relatedProjects[0]!;

    expect(relation.grantToRelatedProject.knowledge).toBeUndefined();
    expect(relation.grantToRelatedProject.entrypoints).toBeUndefined();
    expect(isProjectAccessAllowed(relation.grantToRelatedProject.entrypoints, "kb_search")).toBe(false);
    expect(isProjectAccessAllowed(relation.grantToRelatedProject.knowledge?.read, "knowledge.documents")).toBe(false);
  });

  it("normalizes knowledge and entrypoint grants and writes them back unchanged", () => {
    const projectInfo = normalizeProjectInfo({
      dataStorage: { mode: "both" },
      relatedProjects: [{
        alias: "database",
        projectId: "22222222-2222-4222-8222-222222222222",
        grantToRelatedProject: {
          read: { mode: "all" },
          write: { mode: "none" },
          knowledge: { read: { mode: "all" }, write: { mode: "prefixes", prefixes: ["assistant-"] } },
          entrypoints: { mode: "prefixes", prefixes: ["kb_", "kv_"] },
        },
      }],
    });

    const grant = projectInfo.relatedProjects[0]!.grantToRelatedProject;
    expect(isProjectAccessAllowed(grant.knowledge?.write, "assistant-memory-1")).toBe(true);
    expect(isProjectAccessAllowed(grant.knowledge?.write, "knowledge.document.x")).toBe(false);
    expect(isProjectAccessAllowed(grant.entrypoints, "kb_search")).toBe(true);
    expect(isProjectAccessAllowed(grant.entrypoints, "admin_reset")).toBe(false);

    // What the dialog saves has to be what the next read sees, or an untouched
    // grant would drift every time the project is opened and saved.
    expect(serializeProjectInfo(projectInfo)).toMatchObject({
      relatedProjects: [{
        grantToRelatedProject: {
          read: { mode: "all" },
          write: { mode: "none" },
          knowledge: { read: { mode: "all" }, write: { mode: "prefixes", prefixes: ["assistant-"] } },
          entrypoints: { mode: "prefixes", prefixes: ["kb_", "kv_"] },
        },
      }],
    });
  });

  it("rejects malformed knowledge and entrypoint grants", () => {
    const grantToRelatedProject = { read: { mode: "all" }, write: { mode: "none" } };
    const relation = {
      alias: "database",
      projectId: "22222222-2222-4222-8222-222222222222",
      grantToRelatedProject,
    };

    expect(() => normalizeProjectInfo({
      relatedProjects: [{ ...relation, grantToRelatedProject: { ...grantToRelatedProject, knowledge: { read: { mode: "all" } } } }],
    })).toThrow("knowledge.write");
    expect(() => normalizeProjectInfo({
      relatedProjects: [{ ...relation, grantToRelatedProject: { ...grantToRelatedProject, knowledge: "all" } }],
    })).toThrow("knowledge must be an object");
    expect(() => normalizeProjectInfo({
      relatedProjects: [{ ...relation, grantToRelatedProject: { ...grantToRelatedProject, entrypoints: { mode: "sometimes" } } }],
    })).toThrow("entrypoints.mode must be");
    expect(() => normalizeProjectInfo({
      relatedProjects: [{ ...relation, grantToRelatedProject: { ...grantToRelatedProject, sessions: { mode: "all" } } }],
    })).toThrow("unsupported fields");
  });

  it("rejects malformed or duplicate related-project grants", () => {
    const projectId = "22222222-2222-4222-8222-222222222222";
    const relation = {
      alias: "inventory",
      projectId,
      grantToRelatedProject: {
        read: { mode: "all" },
        write: { mode: "none" },
      },
    };
    expect(() => normalizeProjectInfo({
      relatedProjects: [relation, { ...relation, projectId: "33333333-3333-4333-8333-333333333333" }],
    })).toThrow("duplicate alias");
    expect(() => normalizeProjectInfo({
      relatedProjects: [{
        ...relation,
        grantToRelatedProject: {
          read: { mode: "prefixes", prefixes: ["same:", "same:"] },
          write: { mode: "none" },
        },
      }],
    })).toThrow("contains duplicates");
    expect(() => normalizeProjectInfo({
      relatedProjects: [{ ...relation, alias: "Invalid Alias" }],
    })).toThrow("alias is invalid");
    expect(() => normalizeProjectInfo({
      relatedProjects: [relation, { ...relation, alias: "catalog" }],
    })).toThrow("duplicate projectId");
    expect(() => normalizeProjectInfo({
      relatedProjects: [
        relation,
        { ...relation, alias: "catalog", projectId: projectId.toUpperCase() },
      ],
    })).toThrow("duplicate projectId");
    expect(() => normalizeProjectInfo({
      relatedProjects: [{
        ...relation,
        grantToRelatedProject: {
          read: { mode: "prefixes", prefixes: [] },
          write: { mode: "none" },
        },
      }],
    })).toThrow("must contain 1 to 32 items");
    expect(() => normalizeProjectInfo({
      relatedProjects: [{ ...relation, grantToRelatedProject: undefined }],
    })).toThrow("grantToRelatedProject must be an object");
  });
});
