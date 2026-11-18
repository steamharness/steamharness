# Unreleased

- `defineBot` now requires `engine: "agent"` or `engine: "llm"`. LLM Bots make one model call per turn with the existing model settings and credentials, without starting an Agent or executing tools.
- Workflow LLM providers now use pi-ai and no longer accept AI SDK-specific options. `createLLMNode` still returns the completed reply in one result, but built-in providers require SSE support.
