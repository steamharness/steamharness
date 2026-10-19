import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalWorkflowMcpFileResolver,
  createServerWorkflowMcpFileResolver,
  workflowMcpInputToArgs,
  workflowParamsToMcpElicitationSchema,
  workflowParamsToMcpInputSchema,
  workflowParamsToMcpJsonSchema,
  McpInvalidParamsError,
  type McpManagedFileReference,
  type McpParamDefinition,
} from "../index";

const params: McpParamDefinition[] = [
  {
    name: "message",
    flag: "--message",
    type: "string",
    title: "Message",
    required: true,
    description: "Message to process",
    defaultValue: "hello",
  },
  { name: "count", flag: "--count", type: "number", defaultValue: "2" },
  {
    name: "verbose",
    flag: "--verbose",
    type: "boolean",
    defaultValue: "true",
    options: [{ value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }],
  },
  { name: "tags", flag: "--tags", type: "string", multiple: true, defaultValue: '["a"]' },
  {
    name: "mode",
    flag: "--mode",
    type: "string",
    control: "select",
    options: [{ value: "fast", label: "Fast" }, { value: "safe", label: "Safe" }],
  },
  { name: "date", flag: "--date", type: "string", control: "date" },
  { name: "time", flag: "--time", type: "string", control: "time" },
  { name: "datetime", flag: "--datetime", type: "string", control: "datetime" },
  { name: "period", flag: "--period", type: "string", control: "date-range" },
  { name: "source", type: "positional", required: true },
];

describe("workflow MCP schemas", () => {
  it("maps workflow params to a strict JSON schema", () => {
    const schema = workflowParamsToMcpJsonSchema(params, "local");

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["message", "source"]);
    expect(schema.properties.message).toMatchObject({
      type: "string",
      title: "Message",
      description: "Message to process",
      default: "hello",
    });
    expect(schema.properties.count).toMatchObject({ type: "number", default: 2 });
    expect(schema.properties.verbose).toMatchObject({
      type: "boolean",
      enum: [true, false],
      default: true,
    });
    expect(schema.properties.tags).toMatchObject({
      type: "array",
      items: { type: "string" },
      default: ["a"],
    });
    expect(schema.properties.mode).toMatchObject({ enum: ["fast", "safe"] });
    expect(schema.properties.date).toMatchObject({ format: "date" });
    expect(schema.properties.time).toMatchObject({ pattern: expect.any(String) });
    expect(schema.properties.time).not.toHaveProperty("format");
    expect(schema.properties.datetime).toMatchObject({ pattern: expect.any(String) });
    expect(schema.properties.datetime).not.toHaveProperty("format");
    expect(schema.properties.period).toMatchObject({ pattern: expect.any(String) });
  });

  it("normalizes elicitation defaults and emits protocol-compatible multi-select schemas", () => {
    const schema = workflowParamsToMcpElicitationSchema([
      { name: "count", type: "number" },
      {
        name: "choices",
        type: "string",
        control: "checkboxes",
        options: [{ value: "a" }, { value: "b" }],
      },
    ], {
      count: "3",
      choices: ["a"],
    });

    expect(schema.properties.count).toMatchObject({ type: "number", default: 3 });
    expect(schema.properties.choices).toMatchObject({
      type: "array",
      items: { type: "string", enum: ["a", "b"] },
      default: ["a"],
    });
  });

  it("does not turn empty number defaults or options into zero", () => {
    const schema = workflowParamsToMcpJsonSchema([
      {
        name: "count",
        type: "number",
        defaultValue: "",
        options: [{ value: "" }, { value: "2" }],
      },
    ], "local");

    expect(schema.properties.count).toMatchObject({ type: "number", enum: [2] });
    expect(schema.properties.count).not.toHaveProperty("default");
  });

  it("uses the same normalized number and boolean options for validation and JSON Schema", async () => {
    const normalizedParams: McpParamDefinition[] = [
      { name: "count", type: "number", options: [{ value: "1.0" }, { value: "invalid" }] },
      { name: "enabled", type: "boolean", options: [{ value: "true" }, { value: "invalid" }] },
    ];
    const jsonSchema = workflowParamsToMcpJsonSchema(normalizedParams, "local");
    expect(jsonSchema.properties.count).toMatchObject({ enum: [1] });
    expect(jsonSchema.properties.enabled).toMatchObject({ enum: [true] });

    const inputSchema = workflowParamsToMcpInputSchema(normalizedParams, "local");
    await expect(inputSchema.parseAsync({ count: 1, enabled: true })).resolves.toEqual({
      count: 1,
      enabled: true,
    });
    await expect(inputSchema.parseAsync({ count: 2, enabled: false })).rejects.toThrow(/Expected one of/);
  });

  it("maps multiple boolean params to boolean arrays", async () => {
    const multi = [{
      name: "flags",
      flag: "--flags",
      type: "boolean" as const,
      multiple: true,
      defaultValue: "[true]",
    }];
    expect(workflowParamsToMcpJsonSchema(multi, "local").properties.flags).toMatchObject({
      type: "array",
      items: { type: "boolean" },
      default: [true],
    });
    await expect(workflowParamsToMcpInputSchema(multi, "local").parseAsync({ flags: [false, true] }))
      .resolves.toEqual({ flags: [false, true] });
  });

  it("uses host-specific file contracts and rejects unknown fields", async () => {
    const fileParam: McpParamDefinition[] = [
      { name: "files", flag: "--files", type: "file", multiple: true, required: true },
    ];
    expect(workflowParamsToMcpJsonSchema(fileParam, "local").properties.files).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(workflowParamsToMcpJsonSchema(fileParam, "server").properties.files).toMatchObject({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
    });

    const schema = workflowParamsToMcpInputSchema(params, "local");
    await expect(schema.parseAsync({ message: "hi", source: "input.txt", extra: true }))
      .rejects.toThrow(/unrecognized/i);
    await expect(schema.parseAsync({ message: "hi", source: "input.txt", mode: "other" }))
      .rejects.toThrow(/Expected one of/);
    await expect(schema.parseAsync({ message: "hi", source: "input.txt", date: "07\/01\/2026" }))
      .rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("workflow MCP args and files", () => {
  it("converts typed input to the existing CLI args contract", async () => {
    const args = await workflowMcpInputToArgs({
      projectId: "project-1",
      entrypointId: "main",
      params,
      input: {
        message: "hello world",
        count: 3,
        verbose: false,
        tags: ["one", "two"],
        mode: "safe",
        source: "input.txt",
      },
      fileInputMode: "local",
      signal: new AbortController().signal,
    });

    expect(args).toEqual([
      "--message", "hello world",
      "--count", "3",
      "--verbose", "false",
      "--tags", '["one","two"]',
      "--mode", "safe",
      "input.txt",
    ]);
  });

  it("applies optional static defaults when MCP clients omit those fields", async () => {
    const args = await workflowMcpInputToArgs({
      projectId: "project-1",
      entrypointId: "main",
      params,
      input: { message: "hello", source: "input.txt" },
      fileInputMode: "local",
      signal: new AbortController().signal,
    });

    expect(args).toEqual([
      "--message", "hello",
      "--count", "2",
      "--verbose",
      "--tags", '["a"]',
      "input.txt",
    ]);
  });

  it("serializes multiple boolean params as JSON arrays", async () => {
    const args = await workflowMcpInputToArgs({
      projectId: "project-1",
      entrypointId: "main",
      params: [{ name: "flags", flag: "--flags", type: "boolean", multiple: true }],
      input: { flags: [true, false] },
      fileInputMode: "local",
      signal: new AbortController().signal,
    });
    expect(args).toEqual(["--flags", "[true,false]"]);
  });

  it("imports absolute local paths into the managed-file store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-mcp-files-"));
    const source = path.join(root, "input.txt");
    const store = path.join(root, "store");
    await writeFile(source, "hello", "utf8");
    try {
      const resolveFiles = createLocalWorkflowMcpFileResolver({
        fileStoreDir: store,
        createId: () => "wf_12345678901234567890",
        now: () => new Date("2026-08-28T00:00:00.000Z"),
      });
      const args = await workflowMcpInputToArgs({
        projectId: "project-1",
        entrypointId: "main",
        params: [{ name: "file", flag: "--file", type: "file" }],
        input: { file: source },
        fileInputMode: "local",
        resolveFiles,
        signal: new AbortController().signal,
      });
      const refs = JSON.parse(args[1] ?? "[]") as McpManagedFileReference[];
      expect(args[0]).toBe("--file");
      expect(refs[0]).toMatchObject({
        id: "wf_12345678901234567890",
        workflowId: "project-1",
        storage: "local",
        size: 5,
      });
      expect(await readFile(path.join(store, refs[0]!.id, "content"), "utf8")).toBe("hello");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an empty optional file array as omitted", async () => {
    const resolveFiles = vi.fn();
    await expect(workflowMcpInputToArgs({
      projectId: "project-1",
      entrypointId: "main",
      params: [{ name: "files", flag: "--files", type: "file", multiple: true }],
      input: { files: [] },
      fileInputMode: "local",
      resolveFiles,
      signal: new AbortController().signal,
    })).resolves.toEqual([]);
    expect(resolveFiles).not.toHaveBeenCalled();
  });

  it("rejects relative paths, non-files, and files above the size limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-mcp-invalid-files-"));
    const source = path.join(root, "large.txt");
    await writeFile(source, "large", "utf8");
    try {
      const resolver = createLocalWorkflowMcpFileResolver({ fileStoreDir: root, maxFileSizeBytes: 2 });
      const context = {
        projectId: "project-1",
        entrypointId: "main",
        param: { name: "file", flag: "--file", type: "file" as const },
        signal: new AbortController().signal,
      };
      await expect(resolver(["relative.txt"], context)).rejects.toBeInstanceOf(McpInvalidParamsError);
      await expect(resolver([root], context)).rejects.toBeInstanceOf(McpInvalidParamsError);
      await expect(resolver([source], context)).rejects.toThrow(/exceeds 50MB/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symbolic links even when they point to a regular file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-mcp-symlink-files-"));
    const source = path.join(root, "source.txt");
    const linked = path.join(root, "linked.txt");
    await writeFile(source, "content", "utf8");
    try {
      await symlink(source, linked, "file");
      const resolver = createLocalWorkflowMcpFileResolver({ fileStoreDir: path.join(root, "store") });
      await expect(resolver([linked], {
        projectId: "project-1",
        entrypointId: "main",
        param: { name: "file", flag: "--file", type: "file" as const },
        signal: new AbortController().signal,
      })).rejects.toBeInstanceOf(McpInvalidParamsError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates every local path before importing any managed files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-mcp-atomic-files-"));
    const source = path.join(root, "valid.txt");
    const store = path.join(root, "store");
    await writeFile(source, "valid", "utf8");
    try {
      const resolver = createLocalWorkflowMcpFileResolver({ fileStoreDir: store });
      await expect(resolver([source, "relative.txt"], {
        projectId: "project-1",
        entrypointId: "main",
        param: { name: "files", flag: "--files", type: "file", multiple: true },
        signal: new AbortController().signal,
      })).rejects.toBeInstanceOf(McpInvalidParamsError);
      await expect(readdir(store)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-reads authoritative server metadata and enforces project ownership", async () => {
    const metadata: McpManagedFileReference = {
      id: "wf_server_file_1234567890",
      name: "actual.txt",
      mimeType: "text/plain",
      size: 4,
      kind: "file",
      storage: "server",
      workflowId: "project-1",
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    const resolver = createServerWorkflowMcpFileResolver({
      readFile: async (_projectId, fileId) => fileId === metadata.id ? metadata : undefined,
    });
    const context = {
      projectId: "project-1",
      entrypointId: "main",
      param: { name: "file", flag: "--file", type: "file" as const },
      signal: new AbortController().signal,
    };

    await expect(resolver([{ id: metadata.id, name: "spoofed.txt" }], context))
      .rejects.toBeInstanceOf(McpInvalidParamsError);
    await expect(resolver([{ id: metadata.id }], context)).resolves.toEqual([metadata]);
    await expect(resolver([{ id: "missing" }], context)).rejects.toThrow(/does not belong/);
  });
});
