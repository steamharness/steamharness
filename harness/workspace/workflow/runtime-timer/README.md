# runtime-timer workflow

Workflow timer sample for issue #88. It starts one business timer, waits for the input duration, and explicitly ends it with `workflow.endTimer`.

Inspect structure:

```bash
steamharness structure .
```

Run locally:

```bash
steamharness run . -- --title "Fixture Timer" --milliseconds 2000
```

Inspect the JSON report and timer records:

```bash
steamharness json . -- --title "Fixture Timer" --milliseconds 2000
```

The final report contains `report.timers` with one `success` timer. App Run workspace, public Embed, and server/web run replay render that record as a timer card; while it is running, the same card shows the live elapsed duration.


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
