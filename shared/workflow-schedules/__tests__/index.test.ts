import { describe, expect, it } from "vitest";
import {
  i18n,
  initI18n,
  readWorkflowCodeI18nDescriptor,
  translateWorkflowCodeI18nDescriptor,
  translateWorkflowCodeError,
} from "@workflow-code/i18n";
import {
  getNextWorkflowScheduleOccurrence,
  advanceWorkflowSchedulePastMissed,
  getWorkflowScheduleFireReasonI18n,
  isWorkflowScheduleFireMissed,
  listNextWorkflowScheduleOccurrences,
  parseWorkflowSchedulePresets,
  parseWorkflowScheduleTrigger,
  parseWorkflowScheduleInput,
  previewWorkflowSchedule,
  validateWorkflowScheduleParamValues,
  validateWorkflowScheduleTimezone,
} from "../index";

describe("workflow schedules", () => {
  it("includes both window boundaries and skips the lunch break", () => {
    const occurrences = listNextWorkflowScheduleOccurrences({
      timezone: "Asia/Shanghai",
      after: "2026-08-03T03:25:00.000Z",
      count: 4,
      trigger: {
        kind: "window-interval",
        weekdays: [1, 2, 3, 4, 5],
        windows: [{ start: "09:30", end: "11:30" }, { start: "13:00", end: "15:10" }],
        intervalMinutes: 5,
      },
    });

    expect(occurrences.map((item) => item.toISOString())).toEqual([
      "2026-08-03T03:30:00.000Z",
      "2026-08-03T05:00:00.000Z",
      "2026-08-03T05:05:00.000Z",
      "2026-08-03T05:10:00.000Z",
    ]);
  });

  it("evaluates five-field Cron in the requested timezone", () => {
    expect(getNextWorkflowScheduleOccurrence({
      timezone: "Asia/Shanghai",
      after: "2026-08-03T01:29:30.000Z",
      trigger: { kind: "cron", expression: "30 9 * * 1-5" },
    }).toISOString()).toBe("2026-08-03T01:30:00.000Z");
  });

  it("rejects seconds Cron, overlapping windows, and invalid timezones", () => {
    expect(() => parseWorkflowScheduleTrigger({ kind: "cron", expression: "0 30 9 * * 1-5" }))
      .toThrow(/five fields/);
    expect(() => listNextWorkflowScheduleOccurrences({
      timezone: "Asia/Shanghai",
      after: "2026-08-03T01:29:30.000Z",
      trigger: { kind: "cron", expression: "0 30 9 * * 1-5" },
    })).toThrow(/five fields/);
    expect(() => parseWorkflowScheduleTrigger({
      kind: "window-interval",
      weekdays: [1],
      windows: [{ start: "09:30", end: "11:30" }, { start: "11:30", end: "12:00" }],
      intervalMinutes: 5,
    })).toThrow(/must not overlap/);
    expect(() => parseWorkflowSchedulePresets([{
      id: "daily",
      title: "Daily",
      entrypointId: "main",
      timezone: "Not/A_Timezone",
      trigger: { kind: "cron", expression: "0 9 * * 1-5" },
      paramValues: {},
    }], "workflow")).toThrow(/timezone/);
  });

  it("attaches descriptors so validation errors follow the active language", async () => {
    let failure: unknown;
    try {
      validateWorkflowScheduleTimezone("Not/A_Timezone");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Schedule timezone "Not/A_Timezone" is invalid.');
    expect(readWorkflowCodeI18nDescriptor(failure)).toEqual({
      namespace: "common",
      key: "schedule.validation.timezoneInvalid",
      values: { timezone: "Not/A_Timezone" },
    });

    initI18n({ preference: "zh-CN" });
    expect(translateWorkflowCodeError(failure)).toBe("定时任务时区“Not/A_Timezone”无效。");
    try {
      await i18n.changeLanguage("en");
      expect(translateWorkflowCodeError(failure)).toBe('Schedule timezone "Not/A_Timezone" is invalid.');
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("localizes persisted fire reasons when the active language changes", async () => {
    const descriptor = getWorkflowScheduleFireReasonI18n(
      'Previous fire "fire-1" is still running.',
    );
    expect(descriptor).toEqual({
      namespace: "common",
      key: "schedule.fireReason.previousLocalFireActive",
      values: { fireId: "fire-1", status: "running" },
    });

    initI18n({ preference: "zh-CN" });
    expect(translateWorkflowCodeI18nDescriptor(descriptor, "fallback"))
      .toBe("上一次触发“fire-1”仍处于 running 状态。");
    try {
      await i18n.changeLanguage("en");
      expect(translateWorkflowCodeI18nDescriptor(descriptor, "fallback"))
        .toBe('Previous trigger "fire-1" is still running.');
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("recovers localization data from persisted dependency preflight failures", () => {
    expect(getWorkflowScheduleFireReasonI18n([
      "Workflow project dependencies are not installed.",
      "Project: /workspace/prices",
      "Missing: package-a, package-b",
      "Install dependencies manually in this project directory before running it. Workflow Code will not install or modify dependencies.",
    ].join("\n"))).toEqual({
      namespace: "common",
      key: "schedule.fireReason.dependenciesMissing",
      values: {
        projectPath: "/workspace/prices",
        missing: "package-a, package-b",
      },
    });
  });

  it("parses Workflow presets and rejects them on non-Workflow projects", () => {
    const presets = parseWorkflowSchedulePresets([{
      id: "market-sync",
      title: "Market sync",
      entrypointId: "sync-minute",
      timezone: "Asia/Shanghai",
      trigger: {
        kind: "window-interval",
        weekdays: [5, 1, 1],
        windows: [{ start: "09:30", end: "11:30" }],
        intervalMinutes: 5,
      },
      paramValues: { symbols: "000725.SZ" },
    }], "workflow");

    expect(presets[0]?.trigger).toMatchObject({ weekdays: [1, 5] });
    expect(() => parseWorkflowSchedulePresets([], "kanban")).toThrow(/Only Workflow/);
  });

  it("normalizes schedule input and returns five future occurrences", () => {
    const input = parseWorkflowScheduleInput({
      name: " Market sync ",
      enabled: true,
      resolvedTarget: "1.2.3",
      entrypointId: "sync-minute",
      timezone: "Asia/Shanghai",
      trigger: {
        kind: "window-interval",
        weekdays: [1],
        windows: [{ start: "09:30", end: "09:41" }],
        intervalMinutes: 5,
      },
      paramValues: {},
    });
    expect(input.name).toBe("Market sync");
    expect(previewWorkflowSchedule(input, "2026-08-02T00:00:00.000Z").nextRuns).toEqual([
      "2026-08-03T01:30:00.000Z",
      "2026-08-03T01:35:00.000Z",
      "2026-08-03T01:40:00.000Z",
      "2026-08-03T01:41:00.000Z",
      "2026-08-10T01:30:00.000Z",
    ]);
  });

  it("validates schedule values against static entrypoint parameters", () => {
    const params = [
      { name: "symbols", type: "string" as const, required: true },
      { name: "limit", type: "number" as const },
      { name: "enabled", type: "boolean" as const },
      {
        name: "period",
        type: "string" as const,
        options: [{ value: "daily" }, { value: "weekly" }],
      },
      { name: "dateRange", type: "string" as const, control: "date-range" },
      { name: "tags", type: "string" as const, multiple: true, options: [{ value: "a" }, { value: "b" }] },
    ];

    expect(() => validateWorkflowScheduleParamValues({
      symbols: "000725.SZ",
      limit: 20,
      enabled: false,
      period: "daily",
      dateRange: "2026-07-01/2026-08-04",
      tags: ["a", "b"],
    }, params)).not.toThrow();
    expect(() => validateWorkflowScheduleParamValues({}, params)).toThrow(/symbols is required/);
    expect(() => validateWorkflowScheduleParamValues({ symbols: "000725.SZ", extra: true }, params))
      .toThrow(/unknown parameter.*extra/);
    expect(() => validateWorkflowScheduleParamValues({ symbols: "000725.SZ", limit: "many" }, params))
      .toThrow(/limit must be a number/);
    expect(() => validateWorkflowScheduleParamValues({ symbols: "000725.SZ", enabled: "maybe" }, params))
      .toThrow(/enabled must be a boolean/);
    expect(() => validateWorkflowScheduleParamValues({ symbols: "000725.SZ", period: "monthly" }, params))
      .toThrow(/unsupported option "monthly"/);
    expect(() => validateWorkflowScheduleParamValues({
      symbols: "000725.SZ",
      dateRange: "2026-08-04/2026-07-01",
    }, params)).toThrow(/non-decreasing range/);
    expect(() => validateWorkflowScheduleParamValues({ symbols: "000725.SZ", tags: [] }, [
      { ...params.at(-1)!, required: true },
      params[0]!,
    ])).toThrow(/tags is required/);
  });

  it("skips nonexistent DST wall times and advances missed fires without replay", () => {
    const trigger = {
      kind: "window-interval" as const,
      weekdays: [7],
      windows: [{ start: "02:30", end: "02:30" }],
      intervalMinutes: 5,
    };
    expect(getNextWorkflowScheduleOccurrence({
      timezone: "America/New_York",
      after: "2026-03-08T06:00:00.000Z",
      trigger,
    }).toISOString()).toBe("2026-03-15T06:30:00.000Z");
    expect(advanceWorkflowSchedulePastMissed({
      timezone: "Asia/Shanghai",
      nextFireAt: "2026-08-03T01:30:00.000Z",
      now: "2026-08-03T02:00:00.000Z",
      trigger: { kind: "cron", expression: "30 9 * * 1-5" },
    })).toEqual({ missed: true, nextFireAt: new Date("2026-08-04T01:30:00.000Z") });
  });

  it("treats the exact missed-fire threshold consistently", () => {
    const scheduledFor = "2026-08-03T01:30:00.000Z";
    expect(isWorkflowScheduleFireMissed({
      scheduledFor,
      now: "2026-08-03T01:30:59.999Z",
      missedAfterMs: 60_000,
    })).toBe(false);
    expect(isWorkflowScheduleFireMissed({
      scheduledFor,
      now: "2026-08-03T01:31:00.000Z",
      missedAfterMs: 60_000,
    })).toBe(true);
  });
});
