import { describe, expect, it } from "vitest";
import {
  createDeltaforeApiConfig,
  createObjectConfigPrompt,
  extractToolDefinitions,
  runOpenApiTool,
} from "../openapi";

const openApiDocument = {
  openapi: "3.1.0",
  servers: [
    { url: "http://hookcode.win:7222" },
  ],
  components: {
    parameters: {
      Limit: {
        name: "limit",
        in: "query",
        schema: {
          type: "integer",
          default: 50,
          minimum: 1,
          maximum: 200,
        },
      },
      ObjectId: {
        name: "objectId",
        in: "path",
        required: true,
        schema: {
          type: "integer",
          format: "int64",
        },
      },
      DryRun: {
        name: "dryRun",
        in: "query",
        schema: {
          type: "boolean",
          default: false,
        },
      },
    },
  },
  paths: {
    "/api/guns": {
      get: {
        summary: "查询枪械列表",
        tags: ["枪械"],
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          {
            name: "q",
            in: "query",
            schema: {
              type: "string",
            },
          },
        ],
      },
    },
    "/api/guns/{objectId}/attachments": {
      get: {
        summary: "查询枪械配件槽位",
        tags: ["枪械"],
        parameters: [
          { $ref: "#/components/parameters/ObjectId" },
          {
            name: "scope",
            in: "query",
            schema: {
              type: "string",
              enum: ["accessory", "allAccessory"],
            },
          },
        ],
      },
    },
    "/api/guns/{objectId}/attachment-options": {
      get: {
        summary: "查询枪械可用配件候选明细",
        tags: ["枪械"],
        parameters: [
          { $ref: "#/components/parameters/ObjectId" },
          {
            name: "scope",
            in: "query",
            schema: {
              type: "string",
              enum: ["accessory", "allAccessory"],
            },
          },
          {
            name: "includeEffects",
            in: "query",
            schema: {
              type: "boolean",
              default: true,
            },
          },
          {
            name: "limitPerSlot",
            in: "query",
            schema: {
              type: "integer",
              default: 200,
              minimum: 1,
              maximum: 500,
            },
          },
        ],
      },
    },
    "/api/sync/object-list": {
      post: {
        summary: "从远程物品列表全量同步数据库",
        tags: ["数据同步"],
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: {
              type: "integer",
              default: 2000,
              minimum: 1,
              maximum: 2000,
            },
          },
          { $ref: "#/components/parameters/DryRun" },
        ],
      },
    },
  },
};

const objectConfigDocument = {
  data: {
    gunSlots: [
      {
        slotId: "6",
        slotName: "枪口",
        accType: "accMuzzle",
        sortOrder: 1,
      },
      {
        slotId: "5",
        slotName: "弹匣",
        accType: "accMagazine",
        sortOrder: 24,
      },
    ],
    objectMappings: {
      acc: [
        {
          type: "accMuzzle",
          typeName: "枪口",
          sourceOrder: 0,
        },
        {
          type: "accMagazine",
          typeName: "弹匣",
          sourceOrder: 1,
        },
      ],
    },
    exchange: [
      {
        groupType: "fight",
        groupName: "战斗部门",
        sourceOrder: 0,
        items: [
          {
            type: "gun",
            typeName: "枪械",
            sourceOrder: 0,
          },
        ],
      },
    ],
    maps: {
      gun: [
        {
          mapId: 10001,
          mapName: "长弓溪谷",
          sourceOrder: 0,
        },
      ],
    },
    keyTypes: [
      {
        keyType: "two",
        name: "二指",
        sourceOrder: 0,
      },
    ],
  },
};

describe("deltafore OpenAPI tools", () => {
  it("extracts every supported OpenAPI operation as a tool", () => {
    const tools = extractToolDefinitions(openApiDocument);

    expect(tools.map((tool) => tool.toolName)).toEqual([
      "get_api_guns",
      "get_api_guns_objectId_attachment_options",
      "get_api_guns_objectId_attachments",
      "post_api_sync_object_list",
    ]);
    expect(tools.find((tool) => tool.toolName === "get_api_guns")?.parameters).toMatchObject([
      {
        name: "limit",
        in: "query",
        required: false,
        type: "integer",
        maximum: 200,
      },
      {
        name: "q",
        in: "query",
        required: false,
        type: "string",
      },
    ]);
    expect(tools.find((tool) => tool.toolName === "get_api_guns_objectId_attachment_options")?.parameters)
      .toMatchObject([
        {
          name: "objectId",
          in: "path",
          required: true,
          type: "integer",
        },
        {
          name: "scope",
          in: "query",
          required: false,
          enum: ["accessory", "allAccessory"],
        },
        {
          name: "includeEffects",
          in: "query",
          required: false,
          type: "boolean",
          default: true,
        },
        {
          name: "limitPerSlot",
          in: "query",
          required: false,
          type: "integer",
          maximum: 500,
        },
      ]);
    expect(tools.find((tool) => tool.toolName === "post_api_sync_object_list")?.parameters)
      .toMatchObject([
        {
          name: "limit",
          in: "query",
          type: "integer",
          maximum: 2000,
        },
        {
          name: "dryRun",
          in: "query",
          type: "boolean",
          default: false,
        },
      ]);
  });

  it("loads current OpenAPI metadata and calls the selected HTTP tool", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method,
      });

      if (String(url).endsWith("/openapi.json")) {
        return new Response(JSON.stringify(openApiDocument), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (String(url).endsWith("/api/object-config")) {
        return new Response(JSON.stringify(objectConfigDocument), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      return new Response(JSON.stringify({
        total: 1,
        data: [
          {
            objectId: 18010000016,
            objectName: "M7 战斗步枪",
            primaryClass: "gun",
          },
        ],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as typeof fetch;

    const config = await createDeltaforeApiConfig({
      openApiUrl: "http://hookcode.win:7222/openapi.json",
      fetchImpl,
    });
    const result = await runOpenApiTool(config, "get_api_guns", {
      q: "M7",
      limit: 5,
    }, { fetchImpl });

    expect(config.tools).toHaveLength(4);
    expect(config.objectConfigUrl).toBe("http://hookcode.win:7222/api/object-config");
    expect(config.objectConfigPrompt).toContain("6=枪口/accMuzzle");
    expect(config.objectConfigPrompt).toContain("5=弹匣/accMagazine");
    expect(calls[2]?.url).toBe("http://hookcode.win:7222/api/guns?limit=5&q=M7");
    expect(result.responseSummary).toMatchObject({
      kind: "object",
      total: 1,
      count: 1,
    });
    expect(result.preview).toMatchObject({
      data: [
        {
          objectName: "M7 战斗步枪",
        },
      ],
    });
    expect(result.agentFacts).toMatchObject({
      kind: "object",
      complete: true,
      rowCount: 1,
      notes: [
        "agentFacts.rows contains every row returned by this HTTP response.",
        "Do not treat uiPreview truncation as missing data; use agentFacts.rows for complete returned rows.",
      ],
    });
  });

  it("keeps complete compact agent facts when UI preview rows are clipped", async () => {
    const fetchImpl = (async (url: URL | string) => {
      if (String(url).endsWith("/openapi.json")) {
        return new Response(JSON.stringify(openApiDocument), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (String(url).endsWith("/api/object-config")) {
        return new Response(JSON.stringify(objectConfigDocument), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      return new Response(JSON.stringify({
        data: Array.from({ length: 24 }, (_, index) => ({
          id: 7606 + index,
          gunObjectId: 18010000016,
          slotScope: "allAccessory",
          slotId: String(index + 1),
          sourceOrder: index + 1,
        })),
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as typeof fetch;

    const config = await createDeltaforeApiConfig({
      openApiUrl: "http://hookcode.win:7222/openapi.json",
      fetchImpl,
    });
    const result = await runOpenApiTool(config, "get_api_guns_objectId_attachments", {
      objectId: 18010000016,
      scope: "allAccessory",
    }, { fetchImpl });

    expect(result.previewTruncated).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.agentFacts.complete).toBe(true);
    expect(result.agentFacts.rowCount).toBe(24);
    expect(result.agentFacts.rows).toHaveLength(24);
    expect(result.agentFacts.notes).toContain("agentFacts.rows contains every row returned by this HTTP response.");
  });

  it("passes boolean query parameters from the latest OpenAPI schema", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method,
      });

      if (String(url).endsWith("/openapi.json")) {
        return new Response(JSON.stringify(openApiDocument), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (String(url).endsWith("/api/object-config")) {
        return new Response(JSON.stringify(objectConfigDocument), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      return new Response(JSON.stringify({
        data: {
          slots: [
            {
              slotId: "6",
              slotName: "枪口",
              accType: "accMuzzle",
              optionCount: 1,
              options: [
                {
                  item: {
                    objectId: 13130000182,
                    objectName: "余烬消音器",
                    secondClassCn: "枪口",
                    avgPrice: 49830,
                  },
                  attachment: {
                    recoil: 10,
                    control_speed: -4,
                    control_stable: 4,
                  },
                  effects: [
                    {
                      effectType: "advantage",
                      valueText: "后坐力控制+10",
                      batteryValue: 4,
                    },
                  ],
                },
              ],
            },
          ],
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as typeof fetch;

    const config = await createDeltaforeApiConfig({
      openApiUrl: "http://hookcode.win:7222/openapi.json",
      fetchImpl,
    });
    const result = await runOpenApiTool(config, "get_api_guns_objectId_attachment_options", {
      objectId: 18010000016,
      scope: "allAccessory",
      includeEffects: true,
      limitPerSlot: 10,
    }, { fetchImpl });

    expect(calls[2]?.url).toBe("http://hookcode.win:7222/api/guns/18010000016/attachment-options?scope=allAccessory&includeEffects=true&limitPerSlot=10");
    expect(result.params).toMatchObject({
      objectId: 18010000016,
      scope: "allAccessory",
      includeEffects: true,
      limitPerSlot: 10,
    });
    expect(JSON.stringify(result.agentFacts.rows)).toContain("余烬消音器");
    expect(JSON.stringify(result.agentFacts.rows)).toContain("control_speed");
    expect(JSON.stringify(result.agentFacts.rows)).toContain("后坐力控制+10");
    expect(result.agentFacts.rows).toMatchObject([
      {
        slotName: "枪口",
        optionsSummarized: true,
        originalOptionCount: 1,
      },
    ]);
    expect(result.agentFacts.notes.join("\n")).toContain("representative candidates");
  });

  it("formats object config as a compact system prompt dictionary", () => {
    const prompt = createObjectConfigPrompt(objectConfigDocument);

    expect(prompt).toContain("固定配置字典来自 /api/object-config");
    expect(prompt).toContain("6=枪口/accMuzzle");
    expect(prompt).toContain("5=弹匣/accMagazine");
    expect(prompt).toContain("accMuzzle=枪口");
    expect(prompt).toContain("fight=战斗部门");
    expect(prompt).toContain("10001=长弓溪谷");
    expect(prompt).toContain("two=二指");
  });
});
