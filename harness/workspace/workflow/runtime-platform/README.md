# runtime-platform workflow

Minimal workflow that verifies the runtime platform helpers exposed by the global
`workflow.*` API.

## Run

```bash
workflow-code structure .
workflow-code run .
workflow-code json .
```

The output includes `workflow.getRuntimePlatform()`, `workflow.isCli()`,
and `workflow.isDesktop()`.
