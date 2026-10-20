# details-output workflow

Workflow sample for `workflow.createDetailsOutputNode`.

## Run

```bash
steamharness structure .
steamharness run . -- --icon info --title "点击展开" --content "这里是被折叠的内容。"
steamharness json . -- --icon code --title "Debug payload" --content '{"status":"ok","durationMs":128}'
```

The sample emits a default-collapsed `OutputItem` through a reusable
output node. Its App form intentionally exposes the three details-output inputs
directly: an icon radio group, a title input, and a Markdown content input. In
the App conversation and Output panel, the result should render as a clickable
collapsed output item.


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
