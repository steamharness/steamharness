# details-output workflow

Workflow sample for `workflow.createDetailsOutputNode`.

## Run

```bash
workflow-code structure .
workflow-code run . -- --icon info --title "点击展开" --content "这里是被折叠的内容。"
workflow-code json . -- --icon code --title "Debug payload" --content '{"status":"ok","durationMs":128}'
```

The sample emits a default-collapsed `WorkflowOutputItem` through a reusable
output node. Its App form intentionally exposes the three details-output inputs
directly: an icon radio group, a title input, and a Markdown content input. In
the App conversation and Output panel, the result should render as a clickable
collapsed output item.
