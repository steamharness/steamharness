# gpt-image workflow

GPT Image sample workflow using `gpt-image-2` for conversational image
generation and image editing. It demonstrates textarea prompts, optional image
references, file params, conversation state, and tunable image settings across
CLI, App, and Web runs.

## Install

```bash
cd workspace/workflow/gpt-image
pnpm install
cp .env.example .env
```

For a real local run you can copy `OPENAI_API_KEY` and `OPENAI_BASE_URL` from
`workspace/workflow/game/.env` into this workflow's `.env`. App and Web runs use
the saved project environment values through `workflow.getEnv`.

## Run

Inspect structure:

```bash
workflow-code structure .
```

Generate from text in a conversation:

```bash
workflow-code json . --conversation-id image-demo -- \
  --message "A clean product mockup of a workflow node generating an image" \
  --size 1024x1024 \
  --quality auto \
  --output-format png
```

Follow up in the same conversation. The workflow prepends recent conversation
turns to the latest image prompt and reuses recent input image references, so
references like "make it warmer" can use the prior request and its uploaded
reference images as context:

```bash
workflow-code json . --conversation-id image-demo -- \
  --message "Make it warmer and add a small status badge"
```

Edit with one or more input images. App uploads images into local managed file
storage; Web uploads them into the server managed file store/database path and
passes JSON references to the workflow:

```bash
workflow-code json . --conversation-id image-demo -- \
  --message "Keep the composition but turn it into a blueprint illustration" \
  --images ./__fixtures__/pixel.png \
  --quality high \
  --input-fidelity high \
  --output-format webp \
  --output-compression 90
```

## Conversation Mode

The executor declares `projectType: "conversation"`. App and Web runs open in
the conversation workspace and reuse one `conversationId` per chat. CLI runs
should pass `--conversation-id <id>` when they need multi-turn context.

The workflow stores user prompts, assistant summaries, and input image file
reference metadata in conversation history. Follow-up turns resolve recent
input image references and pass them to the image edit call, capped by a local
safety limit of 16 images. It does not store generated image base64 or input
image base64 in conversation KV, so generated outputs are not reused as image
inputs unless they are uploaded again or saved as managed files by a future
workflow version.

## Parameters

- `--message`: 默认 conversation composer 的主输入。当前请求会和最近的
  conversation 历史组合后再发给 `gpt-image-2`。
- `--images`: optional JSON file references or local paths. When present, or
  when recent conversation context contains prior input images, the workflow
  calls image edit; otherwise it calls image generation.
- `--size`: `1024x1024`, `1536x1024`, `1024x1536`, `auto`, or a custom
  `WIDTHxHEIGHT` supported by `gpt-image-2`.
- `--quality`: `auto`, `low`, `medium`, or `high`.
- `--output-format`: `png`, `jpeg`, or `webp`.
- `--output-compression`: 0-100 for `jpeg` / `webp`; ignored for `png`.
- `--background`: `auto` or `opaque`. `transparent` is rejected because
  `gpt-image-2` does not support transparent backgrounds.
- `--input-fidelity`: `low` or `high` for edit mode.
- `--moderation`: `auto` or `low`.

The generated image is returned as a Markdown output item containing a
`data:image/...;base64,...` preview plus a compact parameter summary. The
workflow does not create a new output file record.

旧的 `--prompt` 仍保留给 CLI 兼容，但新的默认输入框协议统一使用
`--message + --images`。
