# runtime-platform workflow

Minimal workflow that verifies the runtime platform helpers exposed by the global
`workflow.*` API.

## Run

```bash
steamharness structure .
steamharness run .
steamharness json .
```

The output includes `workflow.getRuntimePlatform()`, `workflow.isCli()`,
and `workflow.isDesktop()`.


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
