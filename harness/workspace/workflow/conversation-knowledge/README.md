# conversation-knowledge

Conversation application that stores its transcript in Server conversation tables and mirrors it into a knowledge-base markdown document.

Start a local Docker PostgreSQL and the local Server, sign in with the CLI, create a knowledge base, and configure the authorized ID under `knowledgeBases.data` in root `config.json`. The entry declares `knowledgeBases: ["data"]`. Server does not execute project code; run it locally:

```bash
steamharness structure .
steamharness json . --conversation-id demo-thread -- --message "记录今天的结论"
```

`--dry-run` previews markdown without changing the knowledge document. Persistent conversation history still requires a reachable Server. The same conversation ID updates the same document; authorization is checked for every operation. No local KV or PersistentValue backend is supported.

The composer maps to `--message`; `--title` and `--dry-run` remain auxiliary parameters.

## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Project env files are not loaded.
