# __PROJECT_TITLE__

此 Bot 使用 `steamharness.defineBot` 和 `engine: "llm"`，根据当前对话调用模型并流式输出回复，不启动 Agent 会话。

```sh
steamharness structure .
steamharness web .
```

通过宿主设置或 CLI Web 项目配置选择可用模型。在 `llm.systemPrompt` 中修改系统提示词。
