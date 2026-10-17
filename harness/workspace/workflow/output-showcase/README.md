# output-showcase workflow

演示 **输出选项卡** 在 App / Embed / server/web 上的多种渲染效果：慢速文本流、
带状态切换的模拟工具调用、用户确认分支、计时器卡片。

所有演示中的流式、模拟工具和长任务等待都会响应运行取消；在 App 中点击 Cancel
后，当前阶段会尽快结束并将该运行标记为已中止。

## 流程

1. 输出一段慢速 Markdown 介绍文字（流式）。
2. 工具项先以“进行中”状态出现，等待 `--tool-delay-ms`（默认 3000ms）后切换成“成功”，并回显一条随机项目内容。
3. 再输出一段过渡文字，提示接下来会出现用户确认选项。
4. 暂停等待用户确认（`run-confirmation` 节点）。
5. 确认后：
   - 输出一段「进入长任务」文字。
   - 启动 `long-task-timer` 计时器，等待 `--task-duration-ms`（默认 10000ms）
     后 `endTimer` 显式结束。
   - 输出一段「任务结束」文字，包含计时 ID。
   - 再直接平铺输出一段 JSON 代码块，内容是当前页面所有展示内容组成的原始结果。
6. 选择不执行时直接走 `跳过` 分支，输出一段「已跳过」文字并结束。
   - 结束前同样直接平铺输出当前页面展示内容的原始 JSON。

## Run

Inspect structure:

```bash
workflow-code structure .
```

Direct CLI run（不会暂停，因为直接 CLI 模式下 user input 走
`waiting_for_input` 报告路径，需要用 `--run-id` + `--resolved-user-inputs-json`
恢复）：

```bash
workflow-code json . -- --project-name "output-showcase" --tool-delay-ms 3000 --task-duration-ms 10000 --stream-delay-ms 120
```

Resume with confirmation = true（确认执行长任务）：

```bash
workflow-code json . \
  --run-id <runId> \
  --resolved-user-inputs-json '[{"requestId":"output-showcase:<runId>:run-confirmation","nodeName":"run-confirmation","values":{"decision":"enter"},"submittedAt":"2026-06-10T12:00:00.000Z"}]'
```

Resume with confirmation = false（跳过）：

```bash
workflow-code json . \
  --run-id <runId> \
  --resolved-user-inputs-json '[{"requestId":"output-showcase:<runId>:run-confirmation","nodeName":"run-confirmation","values":{"decision":"skip"},"submittedAt":"2026-06-10T12:00:00.000Z"}]'
```

## 参数

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--project-name` | 介绍文字和最终输出里出现的项目名 | `output-showcase` |
| `--tool-delay-ms` | 模拟工具调用的等待时长（毫秒） | `3000` |
| `--task-duration-ms` | 确认后长任务的等待时长（毫秒） | `10000` |
| `--stream-delay-ms` | 每段流式文字之间的等待时长（毫秒） | `120` |
