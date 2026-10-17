/**
 * Offline fixtures for the M3-driven video understanding flow.
 *
 *  dry-run mode skips B 站 + MiniMax entirely so workspace tests stay
 * fully reproducible without network access or real API keys.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BilibiliDownloadResult,
  DeltaforceBilibiliCollectContext,
  DeltaforceBilibiliCollectParsedInput,
  MinimaxUnderstandRequest,
  MinimaxUnderstandResult,
  MinimaxUploadResult,
} from "../interface";

export async function createDryRunDownloadResult(
  input: DeltaforceBilibiliCollectParsedInput,
): Promise<BilibiliDownloadResult> {
  const dir = await mkdtemp(join(tmpdir(), "workflow-bilibili-mock-"));
  const fakeVideo = join(dir, "mock.mp4");
  await writeFile(fakeVideo, "mock-bilibili-video-bytes");
  return {
    info: {
      bvid: input.bvid,
      aid: 1,
      cid: 1,
      pageIndex: 0,
      pageTitle: "离线演示",
      title: "Delta Force Bilibili M3 Fixture",
      link: input.videoUrl,
      duration: 120,
      ownerName: "workflow-code",
    },
    localVideoPath: fakeVideo,
    size: 24,
  };
}

export function createDryRunUploadResult(
  _localPath: string,
  _options: { purpose?: string },
): MinimaxUploadResult {
  return {
    fileId: "dry-run",
    raw: { file: { file_id: "dry-run", bytes: 0, purpose: _options.purpose ?? "video_understanding" } },
  };
}

export function createDryRunUnderstandResult(
  request: MinimaxUnderstandRequest,
): MinimaxUnderstandResult {
  return {
    transcript: [
      "<think>M3 fixture: simulate reasoning for offline tests.</think>",
      "这是一段离线 fixture 描述。",
      "B 站链接解析、Bilibili 下载、MiniMax 上传、M3 视频理解、知识库写入都已配置完毕。",
      "实际运行需要联网、BILIBILI_SESSDATA 与 MINIMAX_API_KEY。",
    ].join("\n"),
    chunks: 4,
    model: request.model,
  };
}

export function shouldUseDryRunDownload(
  input: DeltaforceBilibiliCollectParsedInput,
  context: DeltaforceBilibiliCollectContext,
): boolean {
  return input.dryRun || context.metadata?.bilibiliDownloadMock === true;
}

export function shouldUseDryRunUnderstand(
  input: DeltaforceBilibiliCollectParsedInput,
  context: DeltaforceBilibiliCollectContext,
): boolean {
  return input.dryRun || context.metadata?.minimaxDryRun === true;
}
