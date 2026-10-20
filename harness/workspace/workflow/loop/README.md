# loop workflow

Workflow sample for `workflow.runFor` and `workflow.runWhile`.

## Run

```bash
steamharness structure .
steamharness run . -- --rounds 3 --target 18
steamharness json . -- --rounds 3 --target 18
```

`runFor` processes a fixed list of round values. `runWhile` keeps boosting the
state until the target is reached. The `runWhile` body intentionally contains a
`runIf` branch and a nested `runFor` so the App Diagram can show multiple loop
and branch levels inside the while container. In the App Diagram, loop bodies
should be wrapped in a tinted loop container while their inner nodes remain
clickable.


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
