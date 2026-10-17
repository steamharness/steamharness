# game workflow

Game-style LLM workflow sample using the platformized global `workflow.*` API.
It is intentionally branch-rich so the App Diagram can show nested execution paths.

## Run

```bash
cp .env.example .env
workflow-code structure .
workflow-code run . -- "secure the city relay"
workflow-code json . -- "secure the city relay"
```

The LLM provider reads `LLM_TYPE`, `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`
through `workflow.getEnv(name)`. Terminal runs load `.env`; App and remote server
runs use the saved project environment values.

## Branch coverage

The workflow uses `workflow.runIf` for several equipment decisions:

- Weapon branch: high-intensity assault, stealth close quarter, or balanced rifle.
- Attachment branch: long-lane optics, silent breach, or sustained fire.
- Medicine branch: heavy attrition kit, fast push stimulant, or field dressing.
- Nested armor triage branch inside the heavy attrition medicine path.
- Armor branch: hold the avenue, scout movement, or balanced plate.

Those branches choose a weapon, attachment, medicine, armor, and route before the
LLM nodes write tactical descriptions. The workflow then uses an LLM question
classifier to judge mission success and streams the final game output.
