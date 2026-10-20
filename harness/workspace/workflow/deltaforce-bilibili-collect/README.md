# deltaforce-bilibili-collect

Downloads a Bilibili video, uploads it to MiniMax, or reuses an existing
MiniMax file id, then asks the M3 video understanding model to describe it and
stores the result as a project knowledge document. It mirrors the validated
Python reference flow so the TypeScript workflow runtime exercises the same
download, upload, and understanding path.

issue #86 phase four replaced the original "subtitle + ffmpeg frame timeline"
flow with a single MiniMax M3 pass. The slow collection work now runs inside a
streaming output node, so App/Web runs can show plain progress text after parsing,
download, upload, M3 understanding, knowledge write, and final result creation.
The workflow continues to write through `workflow.createKnowledgeDocument` /
`editKnowledgeDocument`, so it doubles as a real smoke test for the
PersistentValue knowledge pipeline.

## Run

Dry-run (no B 站, no MiniMax, no knowledge write — just a fixture transcript):

```bash
steamharness json workspace/workflow/deltaforce-bilibili-collect -- \
  --dry-run \
  --video-url https://www.bilibili.com/video/BV1uv411q7Mv \
  --question "讲了什么"
```

Real run (needs `MINIMAX_API_KEY`, optionally B 站 cookies for 1080P+):

```bash
steamharness json workspace/workflow/deltaforce-bilibili-collect -- \
  --video-url https://www.bilibili.com/video/BVxxxxxxxxxx \
  --question "讲了什么" \
  --quality 32 \
  --video-codec auto \
  --keep-video
```

Reuse an existing MiniMax file id and skip B 站 download/upload:

```bash
steamharness json workspace/workflow/deltaforce-bilibili-collect -- \
  --mm-file file-123456 \
  --question "讲了什么"
```

`--quality` follows the B 站 qn convention: 16 (360P) / 32 (480P, default) /
64 (720P) / 80 (1080P, needs SESSDATA) / 112 / 116 / 120 (4K, needs 大会员).
`--video-codec` controls the DASH video stream preference: `auto` (default),
`av1`, `hevc`, or `h264`. In `auto`, the workflow favors lower-bitrate AV1/HEVC
streams before falling back to H.264, matching the validated reference behavior
and reducing MiniMax upload size. Pass `--video-codec h264` only when a downstream player or ffmpeg build
cannot handle AV1/HEVC.
`--video-url` and `--mm-file` are alternative inputs: provide at least one. If
`--mm-file` is present, the workflow skips B 站 parsing, download, and MiniMax
upload, then directly asks M3 to understand `mm_file://<fileId>`.
`--page-index` is 1-based for users and defaults to `1`; the workflow converts
it to the internal 0-based part index only after parsing.
The video is downloaded into a temp directory, ffmpeg remuxes a single FLV
stream or merges a DASH video+audio pair, and the merged `.mp4` is uploaded
to MiniMax with `purpose=video_understanding`. The local file is removed after
the upload unless `--keep-video` is set.

For newer BV ids such as `BV1pGdwBEE7W`, the workflow does not rely on
`bilibili-api-ts`'s local BV-to-aid conversion when fetching the download URL:
it reads the real `aid`/`cid` from B 站 metadata, then calls `playurl` with
`bvid + cid` so a stale local conversion does not surface as `-404: 啥都木有`.

## Pipeline

```
B 站 URL ─► bilibili-api-ts (info/pages)
         ─► direct B 站 playurl (bvid + cid)
         ─► FLV remux / DASH merge via ffmpeg (auto prefers AV1/HEVC)
         ─► MiniMax /v1/files/upload (multipart, purpose=video_understanding)
         ─► MiniMax /v1/chat/completions (model=MiniMax-M3, stream=true, SSE)
         ─► workflow.createKnowledgeDocument / editKnowledgeDocument
         ─► streaming output: plain progress text + final transcript text

mm_file ─► MiniMax /v1/chat/completions (model=MiniMax-M3, stream=true, SSE)
        ─► workflow.createKnowledgeDocument / editKnowledgeDocument
        ─► streaming output: plain progress text + final transcript text
```

The knowledge document is keyed by the BVID + page index; re-running the
workflow updates the existing entry instead of creating a duplicate.

## Environment

`configuration.json` declares every configuration field. The important ones are:

```bash
MINIMAX_API_KEY=...                  # required for real runs
MINIMAX_BASE_URL=https://api.minimaxi.com/v1   # optional override

BILIBILI_SESSDATA=...               # required for 1080P+ / 大会员
BILIBILI_BILI_JCT=...
BILIBILI_BUVID3=...

FFMPEG_PATH=...                     # optional override; otherwise the
                                    # workflow uses @ffmpeg-installer/ffmpeg
                                    # or ffmpeg-static from its own node_modules.
```

`MINIMAX_DRY_RUN=1` (or `--dry-run`) forces the upload + chat completions
calls to return fixture responses, which keeps workspace tests fully offline
without touching real B 站 or MiniMax services. `DELTAFORCE_BILIBILI_DOWNLOAD_MOCK=1`
skips the network download and substitutes a tiny fake mp4 on disk.

## Output

The Markdown document follows the shape:

```markdown
# 视频标题

视频名称：xxx
链接： https://www.bilibili.com/video/BVxxx
BVID：xxx
AID：xxx
CID：xxx
分 P：1
模型：MiniMax-M3
MiniMax 文件：mm_file://12345
问题：讲了什么

## 模型思考
> M3 思考块

## 视频内容描述
M3 输出的视频内容描述。
```

During execution the output stream emits plain text status lines between each
slow step. The final payload keeps that progress item and appends the generated
transcript as a separate plain text output item, so the final result does not
replace earlier stream output and does not render as a detail card.
`steamharness json` returns the same transcript text and a structured
`DeltaforceBilibiliCollectOutputPayload` (`documentId`, `fileId`, `model`,
`transcriptLength`, …).

## License Notes

This sample declares `bilibili-api-ts`, `@ffmpeg-installer/ffmpeg`, and
`ffmpeg-static` inside the workflow package only.
