# classify workflow

LLM text classifier sample using the global `workflow.*` API.

## Run

```bash
steamharness structure .
steamharness run . -- "uniCloud cloud database connection"
steamharness json . -- "uniCloud cloud database connection"
```

The LLM provider reads `LLM_TYPE`, `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`
through `workflow.getConfig(name)`. Studio and CLI share the saved project configuration. Server values are isolated by project and account.


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
