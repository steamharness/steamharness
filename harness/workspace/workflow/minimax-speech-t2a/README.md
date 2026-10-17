# minimax-speech-t2a

MiniMax WebSocket T2A speech synthesis sample. It accepts text, calls
`wss://api.minimaxi.com/ws/v1/t2a_v2`, and returns an audio output item that App,
server embed/replay, and CLI JSON reports can display without uploading a file.

## Flow

```text
input params
  -> validate text and audio settings
  -> MiniMax task_start / task_continue / task_finish
  -> collect task_continued.data.audio hex chunks
  -> output contentType: "audio" with a data:audio/... base64 src
```

MiniMax stays inside this sample. The core runtime only knows that output items
may use `contentType: "audio"`.

## Environment

```bash
cp .env.example .env
```

- `MINIMAX_API_KEY`: required only for live MiniMax calls.

The offline dry-run mode does not need a key and returns a tiny playable WAV
fixture.

## Run

Inspect structure:

```bash
steamharness structure .
```

Offline dry-run:

```bash
steamharness json . -- \
  --dry-run \
  --format wav \
  --text "你好，steamharness 正在合成一段测试语音。"
```

Live MiniMax call:

```bash
steamharness json . -- \
  --text "你好，MiniMax 正在通过 WebSocket 合成语音。" \
  --model speech-2.8-turbo \
  --voice-id male-qn-qingse \
  --format mp3
```

## Parameters

- `--text`: required textarea text.
- `--model`: MiniMax T2A model, default `speech-2.8-turbo`.
- `--voice-id`: voice id, default `male-qn-qingse`.
- `--format`: `mp3`, `wav`, `pcm`, or `flac`; default `mp3`.
- `--sample-rate`: default `32000`.
- `--bitrate`: default `128000`.
- `--channel`: `1` or `2`, default `1`.
- `--speed`: `0.5` to `2`, default `1`.
- `--vol`: `0` to `10`, default `1`.
- `--pitch`: `-12` to `12`, default `0`.
- `--emotion`: optional MiniMax emotion.
- `--language-boost`: optional MiniMax language boost.
- `--dry-run`: use local fixture audio and skip MiniMax.

## Output

The visible output item is:

```ts
{
  contentType: "audio",
  content: {
    src: "data:audio/mpeg;base64,...",
    mimeType: "audio/mpeg",
    name: "minimax-speech.mp3",
    size: 12345,
    durationMs: 1200,
    format: "mp3"
  }
}
```

The first version intentionally uses a data URL instead of
`context.files.createFile(...)` so local CLI/App runs do not require server file
storage.
