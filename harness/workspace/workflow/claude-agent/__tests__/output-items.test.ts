import { describe, expect, it } from "vitest";
import {
  createToolApprovalDecisionChunks,
  createToolResultChunks,
  createToolUseChunks,
  friendlyToolName,
  summarizeToolInputForDisplay,
} from "../output-items";

describe("claude-agent output items", () => {
  describe("friendlyToolName", () => {
    it("strips the mcp__server__ prefix from SDK MCP tool names", () => {
      expect(friendlyToolName("mcp__workflow-knowledge-documents__knowledge_documents")).toBe(
        "knowledge_documents",
      );
    });

    it("leaves non-MCP tool names untouched", () => {
      expect(friendlyToolName("Read")).toBe("Read");
      expect(friendlyToolName("Bash")).toBe("Bash");
    });

    it("falls back to the raw name if the prefix does not match", () => {
      expect(friendlyToolName("mcp__not-well-formed")).toBe("mcp__not-well-formed");
    });
  });

  describe("createToolUseChunks", () => {
    it("renders a friendly name + Chinese action label + target in the title", () => {
      const [start] = createToolUseChunks(
        {
          name: "mcp__workflow-knowledge-documents__knowledge_documents",
          input: { action: "create", documentId: "essay-1", title: "我的小作文" },
        },
        3,
      );
      expect(start).toBeDefined();
      if (start?.type !== "output_item_start") return;

      expect(start.item.title).toBe(
        "knowledge_documents · 创建文档 · 「我的小作文」",
      );
      expect(start.item.iconPreset).toBe("success");
      expect(start.item.contentType).toBe("markdown");
      expect(start.item.collapsed).toBe(true);
      expect(start.item.metadata).toMatchObject({
        kind: "claude-agent-tool",
        tool: "knowledge_documents",
        status: "running",
        action: "create",
        actionLabel: "创建文档",
        documentId: "essay-1",
        title: "我的小作文",
        target: "「我的小作文」",
      });
      const content = String(start.item.content);
      expect(content).toContain("**工具调用** `knowledge_documents`");
      expect(content).toContain("动作：创建文档");
      expect(content).toContain("目标：「我的小作文」");
      expect(content).toContain("**参数**");
      expect(content).toContain("essay-1");
    });

    it("uses the document id as the target when no title is supplied", () => {
      const [start] = createToolUseChunks(
        {
          name: "mcp__workflow-knowledge-documents__knowledge_documents",
          input: { action: "get", documentId: "essay-1" },
        },
        4,
      );
      if (start?.type !== "output_item_start") return;
      expect(start.item.title).toBe("knowledge_documents · 读取文档 · essay-1");
      expect(start.item.iconPreset).toBe("info");
      expect(start.item.metadata).toMatchObject({
        action: "get",
        actionLabel: "读取文档",
        target: "essay-1",
      });
    });

    it("omits the args section when the input is empty", () => {
      const [start] = createToolUseChunks(
        {
          name: "mcp__workflow-knowledge-documents__knowledge_documents",
          input: {},
        },
        1,
      );
      if (start?.type !== "output_item_start") return;
      const content = String(start.item.content);
      expect(content).not.toContain("**参数**");
      expect(start.item.title).toBe("knowledge_documents");
    });

    it("uses the raw tool name for non-MCP tools", () => {
      const [start] = createToolUseChunks(
        { name: "Read", input: { file_path: "/tmp/a.ts" } },
        1,
      );
      if (start?.type !== "output_item_start") return;
      expect(start.item.title).toBe("Read");
      const content = String(start.item.content);
      expect(content).toContain("**工具调用** `Read`");
      expect(content).toContain("**参数**");
    });

    it("falls back to a friendly default for unknown actions", () => {
      const [start] = createToolUseChunks(
        {
          name: "mcp__workflow-knowledge-documents__knowledge_documents",
          input: { action: "explode" },
        },
        1,
      );
      if (start?.type !== "output_item_start") return;
      expect(start.item.title).toBe("knowledge_documents · 调用知识文档");
      expect(start.item.metadata).toMatchObject({
        action: "explode",
        actionLabel: "调用知识文档",
      });
    });
  });

  describe("createToolApprovalDecisionChunks", () => {
    it("creates a durable approved tool permission output item", () => {
      const [start, end] = createToolApprovalDecisionChunks(
        {
          rawToolName: "mcp__workflow-knowledge-documents__knowledge_documents",
          label: "Knowledge Documents",
          status: "approved",
          requestId: "claude-agent:run:tool-approval:knowledge",
          reason: "Claude wants to list knowledge documents.",
          arguments: { action: "list" },
          values: { approved: true },
        },
        2,
      );

      expect(start).toMatchObject({
        type: "output_item_start",
        item: {
          id: "claude-agent-tool-approval-2",
          title: "工具权限审批 · Knowledge Documents · 已批准",
          iconPreset: "success",
          contentType: "markdown",
          collapsed: false,
          metadata: {
            kind: "claude-agent-tool-approval",
            tool: "knowledge_documents",
            rawToolName: "mcp__workflow-knowledge-documents__knowledge_documents",
            status: "approved",
            requestId: "claude-agent:run:tool-approval:knowledge",
          },
        },
      });
      if (start?.type !== "output_item_start") return;
      const content = String(start.item.content);
      expect(content).toContain("**工具权限审批** `knowledge_documents`");
      expect(content).toContain("结果：已批准");
      expect(content).toContain("Claude wants to list knowledge documents.");
      expect(content).toContain('"action": "list"');
      expect(content).toContain('"approved": true');
      expect(end).toEqual({
        type: "output_item_end",
        itemId: "claude-agent-tool-approval-2",
      });
    });
  });

  describe("createToolResultChunks", () => {
    it("emits a friendly action headline for create results", () => {
      const [delta, end] = createToolResultChunks(
        "claude-agent-tool-1",
        "success",
        { action: "create", document: { id: "essay-1", title: "我的小作文" } },
      );
      if (delta?.type !== "output_item_delta") return;
      expect(delta.itemId).toBe("claude-agent-tool-1");
      expect(delta.item?.iconPreset).toBe("success");
      expect(delta.item?.metadata).toMatchObject({
        status: "success",
        action: "create",
        actionLabel: "创建文档",
        documentId: "essay-1",
        documentTitle: "我的小作文",
      });
      const text = String(delta.delta);
      expect(text).toContain("**结果**：创建文档 · 「我的小作文」 · 完成");
      expect(text).toContain("**详情**");
      expect(text).toContain("essay-1");

      expect(end).toEqual({ type: "output_item_end", itemId: "claude-agent-tool-1" });
    });

    it("surfaces count for list results", () => {
      const [delta] = createToolResultChunks(
        "claude-agent-tool-1",
        "success",
        { action: "list", count: 5, documents: [] },
      );
      if (delta?.type !== "output_item_delta") return;
      const text = String(delta.delta);
      expect(text).toContain("**结果**：列出文档 · 5 项 · 完成");
      expect(delta.item?.metadata).toMatchObject({ count: 5 });
    });

    it("surfaces totalMatches for search results", () => {
      const [delta] = createToolResultChunks(
        "claude-agent-tool-1",
        "success",
        { action: "search", totalMatches: 3, matches: [] },
      );
      if (delta?.type !== "output_item_delta") return;
      const text = String(delta.delta);
      expect(text).toContain("**结果**：搜索文档 · 3 处匹配 · 完成");
      expect(delta.item?.metadata).toMatchObject({ totalMatches: 3 });
    });

    it("surfaces deleted for delete results", () => {
      const [delta] = createToolResultChunks(
        "claude-agent-tool-1",
        "success",
        { action: "delete", id: "essay-1", deleted: true },
      );
      if (delta?.type !== "output_item_delta") return;
      const text = String(delta.delta);
      expect(text).toContain("**结果**：删除文档 · 已删除 · 完成");
      expect(delta.item?.metadata).toMatchObject({ deleted: true });
    });

    it("omits the detail section when the result is empty", () => {
      const [delta] = createToolResultChunks("claude-agent-tool-2", "success", undefined);
      if (delta?.type !== "output_item_delta") return;
      const text = String(delta.delta);
      expect(text).toContain("**状态**：完成");
      expect(text).not.toContain("**详情**");
    });

    it("marks failure with the error icon and failed status text", () => {
      const [delta] = createToolResultChunks(
        "claude-agent-tool-3",
        "failed",
        { errCode: 1, errMessage: "boom" },
      );
      if (delta?.type !== "output_item_delta") return;
      expect(delta.item?.iconPreset).toBe("error");
      const text = String(delta.delta);
      expect(text).toContain("**状态**：失败");
      expect(text).toContain("**详情**");
      expect(text).toContain("boom");
    });

    it("accepts title and icon preset overrides for the finish chunk", () => {
      const [delta] = createToolResultChunks(
        "claude-agent-tool-1",
        "success",
        { action: "create", document: { id: "x" } },
        { titleOverride: "Done!", iconPresetOverride: "note" },
      );
      if (delta?.type !== "output_item_delta") return;
      expect(delta.item?.title).toBe("Done!");
      expect(delta.item?.iconPreset).toBe("note");
    });

    it("backfills the action label from the result when the start had no input", () => {
      const start = summarizeToolInputForDisplay(
        "mcp__workflow-knowledge-documents__knowledge_documents",
        {},
      );
      // start should be empty since input is {}
      expect(start.summary.actionLabel).toBeUndefined();

      const [delta] = createToolResultChunks(
        "claude-agent-tool-1",
        "success",
        { action: "create", document: { id: "essay-1", title: "我的小作文" } },
        { startInfo: start },
      );
      if (delta?.type !== "output_item_delta") return;
      expect(delta.item?.title).toBe(
        "knowledge_documents · 创建文档 · 「我的小作文」",
      );
      expect(delta.item?.iconPreset).toBe("success");
      expect(delta.item?.metadata).toMatchObject({
        status: "success",
        action: "create",
        actionLabel: "创建文档",
        documentId: "essay-1",
        documentTitle: "我的小作文",
        target: "「我的小作文」",
      });
      const text = String(delta.delta);
      expect(text).toContain("**结果**：创建文档 · 「我的小作文」 · 完成");
    });

    it("keeps the start-time action label when both start and result have one", () => {
      const start = summarizeToolInputForDisplay(
        "mcp__workflow-knowledge-documents__knowledge_documents",
        { action: "create", title: "原稿" },
      );
      const [delta] = createToolResultChunks(
        "claude-agent-tool-1",
        "success",
        { action: "create", document: { id: "essay-1", title: "原稿" } },
        { startInfo: start },
      );
      if (delta?.type !== "output_item_delta") return;
      // Title matches what the start already produced — no override needed.
      expect(delta.item?.title).toBeUndefined();
      const text = String(delta.delta);
      expect(text).toContain("**结果**：创建文档 · 「原稿」 · 完成");
    });

    it("derives count from the result when start had no input", () => {
      const start = summarizeToolInputForDisplay(
        "mcp__workflow-knowledge-documents__knowledge_documents",
        {},
      );
      const [delta] = createToolResultChunks(
        "claude-agent-tool-1",
        "success",
        { action: "list", count: 7, documents: [] },
        { startInfo: start },
      );
      if (delta?.type !== "output_item_delta") return;
      expect(delta.item?.title).toBe("knowledge_documents · 列出文档 · 7 项");
      const text = String(delta.delta);
      expect(text).toContain("**结果**：列出文档 · 7 项 · 完成");
    });
  });
});
