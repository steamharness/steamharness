# game workflow

Game-style LLM workflow sample using the platformized global `workflow.*` API.
It is intentionally branch-rich so the App Diagram can show nested execution paths.

## Run

```bash
steamharness structure .
steamharness run . -- "secure the city relay"
steamharness json . -- "secure the city relay"
```

The LLM provider reads `LLM_TYPE`, `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`
through `workflow.getConfig(name)`. Studio and CLI share the saved project configuration. Server values are isolated by project and account.

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


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
