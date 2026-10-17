import { describe, expect, it } from "vitest";
import type { AgentDecisionInput } from "../../interface";
import type { DeltaforeApiConfig } from "../../tools/openapi";
import { createAgentPrompt, createSystemPrompt } from "../prompts";

const config: DeltaforeApiConfig = {
  baseUrl: "http://hookcode.win:7222",
  openApiUrl: "http://hookcode.win:7222/openapi.json",
  objectConfigUrl: "http://hookcode.win:7222/api/object-config",
  objectConfigPrompt: [
    "固定配置字典来自 /api/object-config，已在 context 初始化时加载。除非用户明确要求查看原始配置，否则不要再调用 get_api_object_config。",
    "",
    "枪械配件槽位 slotId -> 中文槽位名/配件类型：",
    "- 6=枪口/accMuzzle",
    "- 5=弹匣/accMagazine",
  ].join("\n"),
  tools: [
    {
      toolName: "get_api_guns_objectId_attachment_options",
      method: "GET",
      path: "/api/guns/{objectId}/attachment-options",
      summary: "查询枪械可用配件候选明细",
      tags: ["枪械"],
      parameters: [],
    },
    {
      toolName: "get_api_guns_objectId_attachments",
      method: "GET",
      path: "/api/guns/{objectId}/attachments",
      summary: "查询枪械配件槽位",
      tags: ["枪械"],
      parameters: [],
    },
  ],
};

describe("deltafore agent prompts", () => {
  it("injects stable object config dictionaries into the system prompt", () => {
    const prompt = createSystemPrompt(config);

    expect(prompt).toContain("Thought -> Action -> Observation -> Thought");
    expect(prompt).toContain("\"phase\":\"action\"");
    expect(prompt).toContain("\"phase\":\"final_answer\"");
    expect(prompt).toContain("thought.summary 必须是可展示给用户的公开思考摘要");
    expect(prompt).toContain("Action 只能是一个线上 OpenAPI 工具调用");
    expect(prompt).toContain("Observation 由系统在工具返回后写入");
    expect(prompt).toContain("固定配置字典：");
    expect(prompt).toContain("6=枪口/accMuzzle");
    expect(prompt).toContain("5=弹匣/accMagazine");
    expect(prompt).toContain("不要再调用 get_api_object_config");
    expect(prompt).toContain("get_api_guns_objectId_attachments 现在会返回 slotName / accType");
    expect(prompt).toContain("优先调用 get_api_guns_objectId_attachment_options");
    expect(prompt).toContain("dryRun=true");
    expect(prompt).toContain("get_api_guns_objectId_attachment_options(objectId, scope=\"allAccessory\", includeEffects=true");
  });

  it("feeds compact agent facts to the LLM instead of clipped UI preview rows", () => {
    const state: AgentDecisionInput = {
      errCode: 0,
      errMessage: "",
      query: "M7 有哪些槽位可以安装？",
      maxRounds: 10,
      round: 2,
      history: [],
      steps: [
        {
          round: 1,
          thought: {
            summary: "已经有了枪械 ID，需要确认完整槽位。",
          },
          action: {
            toolName: "get_api_guns_objectId_attachments",
            args: {
              objectId: 18010000016,
              scope: "allAccessory",
            },
          },
          observation: "HTTP 200 GET /api/guns/{objectId}/attachments；推理可用行 24 条",
          status: "observed",
          toolResult: {
            toolName: "get_api_guns_objectId_attachments",
            args: {
              objectId: 18010000016,
              scope: "allAccessory",
            },
            ok: true,
            summary: "get_api_guns_objectId_attachments returned HTTP 200.",
            data: {
              status: 200,
              statusText: "OK",
              method: "GET",
              path: "/api/guns/{objectId}/attachments",
              params: {
                objectId: 18010000016,
                scope: "allAccessory",
              },
              preview: {
                data: [{ slotId: "6" }],
                truncated: true,
              },
              previewTruncated: true,
              responseSummary: {
                kind: "object",
                count: 24,
              },
              agentFacts: {
                kind: "object",
                complete: true,
                truncated: false,
                rowsKey: "data",
                rowCount: 24,
                rows: Array.from({ length: 24 }, (_, index) => ({
                  slotId: String(index + 1),
                  sourceOrder: index + 1,
                })),
                notes: [
                  "agentFacts.rows contains every row returned by this HTTP response.",
                  "Do not treat uiPreview truncation as missing data; use agentFacts.rows for complete returned rows.",
                ],
              },
            },
          },
        },
      ],
    };

    const prompt = createAgentPrompt(state, config);

    expect(prompt).toContain("\"agentFacts\"");
    expect(prompt).toContain("\"rowCount\": 24");
    expect(prompt).toContain("\"slotId\": \"24\"");
    expect(prompt).not.toContain("\"preview\"");
    expect(prompt).not.toContain("\"previewTruncated\"");
  });
});
