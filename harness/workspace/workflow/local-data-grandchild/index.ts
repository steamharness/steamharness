import { randomUUID } from "node:crypto";
import type {
  GetDataInput,
  StorageDataOutput,
  StoreDataInput,
} from "./interface";

const STORAGE_LOCATION = "local" as const;
const PROJECT_TITLE = "本地数据测试孙项目";
const STORAGE_KEY_PREFIX = "stored-content:";

const storageDataOutputNode = steamharness.createOutputNode<StorageDataOutput, StorageDataOutput>({
  name: "storage-data-output",
  format(result) {
    const content = JSON.stringify({
      action: result.action,
      storageLocation: result.storageLocation,
      target: result.target,
      alias: result.alias,
      id: result.id,
      ...(result.action === "get" ? { content: result.content } : {}),
    }, null, 2);

    return {
      ...steamharness.createOutputPayload({
        items: [{
          id: "storage-data-result",
          title: result.action === "store" ? "数据已存储" : "数据读取结果",
          content,
          contentType: "json",
          collapsed: false,
        }],
      }),
      action: result.action,
      storageLocation: result.storageLocation,
      target: result.target,
      alias: result.alias,
      id: result.id,
      ...(result.action === "get" ? { content: result.content } : {}),
    };
  },
});

export const storeDataProject = steamharness.defineProject<StoreDataInput, StorageDataOutput>({
  name: `${PROJECT_TITLE} - 存储数据`,
  async run(input, context) {
    const alias = readOptionalString(input.alias);
    const storage = context.storage[STORAGE_LOCATION];
    const kv = alias === undefined ? storage.kv : storage.relatedProjects.get(alias).kv;
    const id = randomUUID();
    await kv.setValue(createStorageKey(id), input.content);

    return steamharness.runNode(storageDataOutputNode, {
      errCode: 0,
      errMessage: "",
      items: [],
      action: "store",
      storageLocation: STORAGE_LOCATION,
      target: alias === undefined ? "current" : "related",
      alias,
      id,
    }, context);
  },
});

export const getDataProject = steamharness.defineProject<GetDataInput, StorageDataOutput>({
  name: `${PROJECT_TITLE} - 读取数据`,
  async run(input, context) {
    const id = readRequiredId(input.id);
    const alias = readOptionalString(input.alias);
    const storage = context.storage[STORAGE_LOCATION];
    const kv = alias === undefined ? storage.kv : storage.relatedProjects.get(alias).kv;
    const content = await kv.getValue(createStorageKey(id));
    if (content === undefined) {
      throw new steamharness.HarnessError({
        type: "input_validation",
        message: `未找到 id 为“${id}”的数据。`,
      });
    }

    return steamharness.runNode(storageDataOutputNode, {
      errCode: 0,
      errMessage: "",
      items: [],
      action: "get",
      storageLocation: STORAGE_LOCATION,
      target: alias === undefined ? "current" : "related",
      alias,
      id,
      content,
    }, context);
  },
});

export const executor = steamharness.defineExecutor({
  projectType: "workflow",
  defaultEntrypoint: "store",
  entrypoints: [
    steamharness.defineEntrypoint<StoreDataInput, StorageDataOutput>({
      id: "store",
      title: "存储数据",
      description: "输入内容并返回可用于读取的 id。",
      workflow: storeDataProject,
      params: [
        {
          name: "content",
          flag: "--content",
          type: "string",
          required: true,
          control: "textarea",
          title: "存储内容",
        },
        {
          kind: "auxiliary",
          id: "advanced",
          label: "Advanced",
          fields: [
            {
              name: "alias",
              flag: "--alias",
              type: "string",
              title: "关联项目 alias",
              description: "留空时存入当前项目；填写时存入该直接关联项目。",
            }
          ],
        },
      ],
      createInput({ paramValues }) {
        return {
          errCode: 0,
          errMessage: "",
          alias: readOptionalString(paramValues.alias),
          content: readRequiredContent(paramValues.content),
        };
      },
    }),
    steamharness.defineEntrypoint<GetDataInput, StorageDataOutput>({
      id: "get",
      title: "读取数据",
      description: "输入存储时返回的 id 并读取内容。",
      workflow: getDataProject,
      params: [
        {
          name: "id",
          flag: "--id",
          type: "string",
          required: true,
          title: "数据 id",
        },
        {
          kind: "auxiliary",
          id: "advanced",
          label: "Advanced",
          fields: [
            {
              name: "alias",
              flag: "--alias",
              type: "string",
              title: "关联项目 alias",
              description: "留空时读取当前项目；填写时读取该直接关联项目。",
            }
          ],
        },
      ],
      createInput({ paramValues }) {
        return {
          errCode: 0,
          errMessage: "",
          alias: readOptionalString(paramValues.alias),
          id: readRequiredId(paramValues.id),
        };
      },
    }),
  ],
});

export { storeDataProject as workflow };
export default storeDataProject;

function createStorageKey(id: string): string {
  return `${STORAGE_KEY_PREFIX}${id}`;
}

function readRequiredContent(value: unknown): string {
  if (typeof value === "string") return value;
  throw new steamharness.HarnessError({
    type: "input_validation",
    message: "存储内容不能为空。",
  });
}

function readRequiredId(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new steamharness.HarnessError({
    type: "input_validation",
    message: "数据 id 不能为空。",
  });
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
