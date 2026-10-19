import { randomUUID } from "node:crypto";
import type {
  GetDataInput,
  NoteDataInput,
  NoteDataOutput,
  StorageDataOutput,
  StoreDataInput,
} from "./interface";

const STORAGE_LOCATION = "local" as const;
const PROJECT_TITLE = "本地数据测试项目";
const STORAGE_KEY_PREFIX = "stored-content:";

const storageDataOutputNode = workflow.createOutputNode<StorageDataOutput, StorageDataOutput>({
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
      ...workflow.createOutputPayload({
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

export const storeDataWorkflow = workflow.defineWorkflow<StoreDataInput, StorageDataOutput>({
  name: `${PROJECT_TITLE} - 存储数据`,
  async run(input, context) {
    const alias = readOptionalString(input.alias);
    const storage = context.storage[STORAGE_LOCATION];
    const kv = alias === undefined ? storage.kv : storage.relatedProjects.get(alias).kv;
    const id = randomUUID();
    await kv.setValue(createStorageKey(id), input.content);

    return workflow.runNode(storageDataOutputNode, {
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

export const getDataWorkflow = workflow.defineWorkflow<GetDataInput, StorageDataOutput>({
  name: `${PROJECT_TITLE} - 读取数据`,
  async run(input, context) {
    const id = readRequiredId(input.id);
    const alias = readOptionalString(input.alias);
    const storage = context.storage[STORAGE_LOCATION];
    const kv = alias === undefined ? storage.kv : storage.relatedProjects.get(alias).kv;
    const content = await kv.getValue(createStorageKey(id));
    if (content === undefined) {
      throw new workflow.HarnessError({
        type: "input_validation",
        message: `未找到 id 为“${id}”的数据。`,
      });
    }

    return workflow.runNode(storageDataOutputNode, {
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

const noteDataOutputNode = workflow.createOutputNode<NoteDataOutput, NoteDataOutput>({
  name: "note-data-output",
  format(result) {
    return {
      ...workflow.createOutputPayload({
        items: [{
          id: "note-data-result",
          title: "关联项目知识库",
          content: JSON.stringify({
            alias: result.alias,
            documentId: result.documentId,
            relatedDocuments: result.relatedDocuments,
            ...(result.content === undefined ? {} : { content: result.content }),
          }, null, 2),
          contentType: "json",
          collapsed: false,
        }],
      }),
      action: "note",
      alias: result.alias,
      documentId: result.documentId,
      relatedDocuments: result.relatedDocuments,
      ...(result.content === undefined ? {} : { content: result.content }),
    };
  },
});

/**
 * Writes a document into a related project through its own entrypoint, then
 * reads it back through the related knowledge scope.
 *
 * Both halves are the related-project surface: `runEntrypoint` reaches the
 * child's workflow — the code that project's author wrote for its own store —
 * and `knowledge` reads what that call put into the child's knowledge base.
 */
export const noteDataWorkflow = workflow.defineWorkflow<NoteDataInput, NoteDataOutput>({
  name: `${PROJECT_TITLE} - 经关联项目写入知识库`,
  async run(input, context) {
    const alias = readRequiredAlias(input.alias);
    const related = context.storage[STORAGE_LOCATION].relatedProjects.get(alias);
    const created = await related.runEntrypoint("note", [
      "--title", input.title,
      "--markdown", input.markdown,
    ]);
    const documentId = readCreatedDocumentId(created);
    const documents = (await related.knowledge.listDocuments()).items;
    const document = await related.knowledge.getDocument(documentId);

    return workflow.runNode(noteDataOutputNode, {
      errCode: 0,
      errMessage: "",
      items: [],
      action: "note",
      alias,
      documentId,
      relatedDocuments: documents.length,
      ...(document === undefined ? {} : { content: document.markdown }),
    }, context);
  },
});

export const executor = workflow.defineExecutor({
  projectType: "workflow",
  defaultEntrypoint: "store",
  entrypoints: [
    workflow.defineEntrypoint<StoreDataInput, StorageDataOutput>({
      id: "store",
      title: "存储数据",
      description: "输入内容并返回可用于读取的 id。",
      workflow: storeDataWorkflow,
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
    workflow.defineEntrypoint<GetDataInput, StorageDataOutput>({
      id: "get",
      title: "读取数据",
      description: "输入存储时返回的 id 并读取内容。",
      workflow: getDataWorkflow,
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
    workflow.defineEntrypoint<NoteDataInput, NoteDataOutput>({
      id: "note",
      title: "经关联项目写入知识库",
      description: "调用关联项目的 note 入口写入文档，再通过关联知识库读回来。",
      workflow: noteDataWorkflow,
      params: [
        {
          name: "alias",
          flag: "--alias",
          type: "string",
          required: true,
          title: "关联项目 alias",
        },
        {
          name: "title",
          flag: "--title",
          type: "string",
          required: true,
          title: "文档标题",
        },
        {
          name: "markdown",
          flag: "--markdown",
          type: "string",
          required: true,
          control: "textarea",
          title: "文档内容",
        },
      ],
      createInput({ paramValues }) {
        return {
          errCode: 0,
          errMessage: "",
          alias: readRequiredAlias(paramValues.alias),
          title: readRequiredId(paramValues.title),
          markdown: readRequiredContent(paramValues.markdown),
        };
      },
    }),
  ],
});

export { storeDataWorkflow as workflow };
export default storeDataWorkflow;

function createStorageKey(id: string): string {
  return `${STORAGE_KEY_PREFIX}${id}`;
}

function readRequiredContent(value: unknown): string {
  if (typeof value === "string") return value;
  throw new workflow.HarnessError({
    type: "input_validation",
    message: "存储内容不能为空。",
  });
}

function readRequiredId(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new workflow.HarnessError({
    type: "input_validation",
    message: "数据 id 不能为空。",
  });
}

function readRequiredAlias(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new workflow.HarnessError({
    type: "input_validation",
    message: "关联项目 alias 不能为空。",
  });
}

/** The document id the related entrypoint handed back, or a clear failure. */
function readCreatedDocumentId(value: unknown): string {
  const documentId = (value as { documentId?: unknown } | null | undefined)?.documentId;
  if (typeof documentId === "string" && documentId !== "") return documentId;
  throw new workflow.HarnessError({
    type: "execution",
    message: `关联项目的 note 入口没有返回文档 id：${JSON.stringify(value)}`,
  });
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
