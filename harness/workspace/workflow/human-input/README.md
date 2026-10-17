# human-input workflow

Durable human input sample for `workflow.createUserInputNode(...)`.

This sample starts without executor input. It first outputs:

```text
下面需要请求网络访问权限，请你同意开启
```

Then it pauses and shows a permission request form. If the user agrees, the
workflow outputs `成功获取权限`; otherwise it outputs `获取权限失败`.

## Run

Inspect the structure:

```bash
steamharness structure .
```

Start a run. The first JSON report pauses with `status: "waiting_for_input"`,
already containing the intro text output and `pendingUserInput`:

```bash
steamharness json .
```

Resume the same run by passing the original `runId` and a resolved answer:

```bash
steamharness json . \
  --run-id <runId> \
  --resolved-user-inputs-json '[{"requestId":"human-input:<runId>:network-permission","nodeName":"network-permission","values":{"allowed":true},"submittedAt":"2026-06-04T10:30:00.000Z"}]'
```

Use `"allowed": false` to test the denied branch.
