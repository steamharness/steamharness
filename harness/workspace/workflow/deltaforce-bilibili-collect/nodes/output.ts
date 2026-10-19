import type {
  DeltaforceBilibiliCollectDocument,
  DeltaforceBilibiliCollectOutputPayload,
} from "../interface";

type OutputItemInput = Omit<DeltaforceBilibiliCollectOutputPayload["items"][number], "id"> & { id?: string };

export function createOutputPayloadFromDocument(
  document: DeltaforceBilibiliCollectDocument,
  existingItems: OutputItemInput[] = [],
): DeltaforceBilibiliCollectOutputPayload {
  const base = steamharness.createOutputPayload({
    items: [
      ...existingItems,
      {
        id: document.documentId,
        title: "Output",
        content: document.markdown,
        contentType: "text",
      },
    ],
  }) as {
    errCode: number;
    errMessage: string;
    items: DeltaforceBilibiliCollectOutputPayload["items"];
  };

  return {
    ...base,
    documentId: document.documentId,
    documentTitle: document.documentTitle,
    videoTitle: document.info.title,
    videoUrl: document.info.link,
    bvid: document.info.bvid,
    aid: document.info.aid,
    cid: document.info.cid,
    pageIndex: document.info.pageIndex,
    model: document.model,
    fileId: document.fileId,
    promptSeconds: document.promptSeconds,
    transcriptLength: document.transcript.length,
    knowledgeWritten: document.knowledgeWritten,
    dryRun: document.dryRun,
  };
}
