# loop workflow

Workflow sample for `workflow.runFor` and `workflow.runWhile`.

## Run

```bash
workflow-code structure .
workflow-code run . -- --rounds 3 --target 18
workflow-code json . -- --rounds 3 --target 18
```

`runFor` processes a fixed list of round values. `runWhile` keeps boosting the
state until the target is reached. The `runWhile` body intentionally contains a
`runIf` branch and a nested `runFor` so the App Diagram can show multiple loop
and branch levels inside the while container. In the App Diagram, loop bodies
should be wrapped in a tinted loop container while their inner nodes remain
clickable.
