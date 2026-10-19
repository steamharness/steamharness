# gitlab-webhook

Receive GitLab project webhook payloads and print compact event fields.

This workflow is a smoke-test target for GitLab Project webhooks. It accepts a
GitLab webhook JSON payload and prints a compact text summary with one field per
line so the server UI can show the received event directly.

## Run locally

Inspect structure:

```bash
steamharness structure .
```

Execute:

```bash
steamharness run . -- --payload '{"object_kind":"issue","object_attributes":{"iid":1,"action":"open","title":"Demo","url":"http://example/issues/1"},"project":{"path_with_namespace":"ai/steamharness"},"user":{"username":"root"}}' --message "fixture note"
```

Generate JSON report:

```bash
steamharness json . --conversation-id gitlab-demo -- --payload '{"object_kind":"push","checkout_sha":"abc","commits":[{"id":"abc","message":"demo","url":"http://example/commit/abc"}],"project":{"path_with_namespace":"ai/steamharness"}}' --message "webhook replay"
```

这个示例的默认 composer 也会映射到 `--message`，但主输入仍然是
`--payload`；默认输入框更适合做多轮 replay note，而不是替代 webhook
JSON 本体。

Output example:

```text
event=issue
action=open
id=1
url=http://example/issues/1
content=Demo
project=ai/steamharness
author=root
rawEvent=issue
```

## Server webhook

Configure the SteamHarness Server webhook with full-body mapping:

```json
{
  "enabled": true,
  "target": "latest",
  "mapping": [
    { "bodyPath": "$", "inputName": "payload" }
  ]
}
```

Use the returned secret as the GitLab hook token. The public callback for this
workspace is:

```text
http://yuhe.space:7130/webhooks/gitlab-webhook/trigger
```

如果你是在本机开发环境里联调，而不是走发布/部署态入口，通常仍会使用 `http://localhost:7125/...` 这一套 `712x` 端口带。

GitLab Project hook events to enable:

- Push events
- Issues events
- Comments

GitLab Project hooks do not reliably emit fork creation events for the source
project. If a `project_create` or `fork` payload reaches this workflow, it is
summarized as `event=fork`; otherwise fork creation requires a GitLab system or
group hook outside this project-only test case.
