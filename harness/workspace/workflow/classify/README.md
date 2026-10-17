# classify workflow

LLM text classifier sample using the global `workflow.*` API.

## Run

```bash
cp .env.example .env
workflow-code structure .
workflow-code run . -- "uniCloud cloud database connection"
workflow-code json . -- "uniCloud cloud database connection"
```

The LLM provider reads `LLM_TYPE`, `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`
through `workflow.getEnv(name)`. Terminal runs load `.env`; App and remote server
runs use the saved project environment values.
