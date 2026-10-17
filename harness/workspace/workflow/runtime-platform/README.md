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
