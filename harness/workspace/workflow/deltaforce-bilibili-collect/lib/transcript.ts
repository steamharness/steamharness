/**
 * Turn a MiniMax M3 transcript into a Markdown knowledge document.
 *
 *  the M3 streaming model may interleave 思考 (thinking) blocks with
 * the visible content; the parser keeps both so the knowledge document
 * preserves the model's reasoning.
 */

export interface TranscriptEntry {
  kind: "thinking" | "content";
  text: string;
}

const THINKING_OPEN = "<think>";
const THINKING_CLOSE = "</think>";

export function splitTranscriptByThinking(transcript: string): TranscriptEntry[] {
  if (transcript === "") {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  let cursor = 0;
  while (cursor < transcript.length) {
    const open = transcript.indexOf(THINKING_OPEN, cursor);
    if (open === -1) {
      const tail = transcript.slice(cursor).trim();
      if (tail !== "") {
        entries.push({ kind: "content", text: tail });
      }
      break;
    }
    const prefix = transcript.slice(cursor, open).trim();
    if (prefix !== "") {
      entries.push({ kind: "content", text: prefix });
    }
    const close = transcript.indexOf(THINKING_CLOSE, open + THINKING_OPEN.length);
    if (close === -1) {
      const tail = transcript.slice(open).trim();
      if (tail !== "") {
        entries.push({ kind: "thinking", text: tail });
      }
      break;
    }
    const thinkBody = transcript.slice(open + THINKING_OPEN.length, close).trim();
    if (thinkBody !== "") {
      entries.push({ kind: "thinking", text: thinkBody });
    }
    cursor = close + THINKING_CLOSE.length;
  }
  return entries;
}

export interface TranscriptSection {
  kind: "thinking" | "content";
  text: string;
}

export interface TranscriptMarkdownInput {
  title: string;
  video: {
    bvid: string;
    aid: number;
    cid: number;
    pageIndex: number;
    pageTitle?: string;
    link: string;
    duration: number;
  };
  model: string;
  question: string;
  promptSeconds: number;
  transcript: string;
  fileId: string;
  knowledgeWritten: boolean;
  dryRun: boolean;
}

export function transcriptToMarkdown(input: TranscriptMarkdownInput): string {
  const sections = splitTranscriptByThinking(input.transcript);
  const lines: string[] = [
    `# ${escapeHeading(input.title)}`,
    "",
    `视频名称：${escapeText(input.title)}`,
    `链接： ${input.video.link}`,
    `BVID：${input.video.bvid}`,
    `AID：${input.video.aid}`,
    `CID：${input.video.cid}`,
    `分 P：${input.video.pageIndex + 1}${input.video.pageTitle ? ` - ${escapeText(input.video.pageTitle)}` : ""}`,
    `模型：${input.model}`,
    `MiniMax 文件：mm_file://${input.fileId}`,
    `问题：${escapeText(input.question)}`,
    "",
  ];

  if (sections.length === 0) {
    lines.push("_（MiniMax 未返回描述）_", "");
  } else {
    const hasThinking = sections.some((section) => section.kind === "thinking");
    if (hasThinking) {
      lines.push("## 模型思考", "");
      for (const section of sections) {
        if (section.kind !== "thinking") {
          continue;
        }
        lines.push(...section.text.split(/\r?\n/).map((line) => `> ${line}`));
        lines.push("");
      }
    }
    lines.push("## 视频内容描述", "");
    const contentText = sections
      .filter((section) => section.kind === "content")
      .map((section) => section.text)
      .join("\n\n")
      .trim();
    lines.push(contentText === "" ? "_（模型未给出可见描述）_" : contentText);
  }

  if (input.dryRun) {
    lines.push("", "> 提示：这是 dry-run 模式下的离线样例输出，不会写入知识库。");
  } else if (!input.knowledgeWritten) {
    lines.push("", "> 提示：本轮运行未将结果写入知识库。");
  }

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd();
}

function escapeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim() || "Bilibili Video Description";
}

function escapeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
