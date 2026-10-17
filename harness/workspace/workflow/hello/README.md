# hello workflow

Minimal LLM workflow sample using the platformized global `workflow.*` API.

## Run

```bash
cp .env.example .env
steamharness structure .
steamharness run .
steamharness json .
```

The LLM provider reads `LLM_TYPE`, `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`
through `workflow.getEnv(name)`. Terminal runs load `.env`; App and remote server
runs use the saved project environment values.
