import { TZDate } from "@date-fns/tz";
import { CronExpressionParser } from "cron-parser";

export const STEAMHARNESS_SCHEDULE_PRESET_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const STEAMHARNESS_SCHEDULE_NAME_MAX_LENGTH = 100;
export const STEAMHARNESS_SCHEDULE_MAX_PRESETS = 20;
export const STEAMHARNESS_SCHEDULE_MAX_WINDOWS = 12;
export const STEAMHARNESS_SCHEDULE_MAX_INTERVAL_MINUTES = 1_440;

export interface ScheduleI18nDescriptor {
  namespace: "common";
  key: string;
  values?: Record<string, unknown>;
}

export interface ScheduleLocalizedError extends Error {
  steamHarnessI18n: ScheduleI18nDescriptor;
}

export interface ScheduleWindow {
  start: string;
  end: string;
}

export type ScheduleTrigger =
  | {
      kind: "window-interval";
      weekdays: number[];
      windows: ScheduleWindow[];
      intervalMinutes: number;
    }
  | {
      kind: "cron";
      expression: string;
    };

export interface SchedulePreset {
  id: string;
  title: string;
  description?: string;
  entrypointId: string;
  timezone: string;
  trigger: ScheduleTrigger;
  paramValues: Record<string, unknown>;
}

export interface ScheduleInput {
  name: string;
  enabled: boolean;
  resolvedTarget: string;
  entrypointId: string;
  timezone: string;
  trigger: ScheduleTrigger;
  paramValues: Record<string, unknown>;
}

export interface ScheduleParamDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "positional" | "file";
  required?: boolean;
  defaultValue?: string;
  multiple?: boolean;
  control?: string;
  options?: ReadonlyArray<{ value: string }>;
}

export interface ScheduleOccurrencePreview {
  nextRuns: string[];
}

export type ScheduleFireStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "waiting_for_input"
  | "skipped_overlap"
  | "skipped_missed"
  | "skipped_authorization"
  | "skipped_invalid_target";

export interface ScheduleSourceMetadata {
  source: "schedule";
  scheduleId: string;
  scheduleName: string;
  fireId: string;
  scheduledFor: string;
  triggerKind: ScheduleTrigger["kind"];
}

export interface ScheduleRecord extends ScheduleInput {
  id: string;
  workflowId: string;
  createdByUserId: string;
  nextFireAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleFireRecord {
  id: string;
  scheduleId: string;
  workflowId: string;
  scheduledFor: string;
  status: ScheduleFireStatus;
  runId?: string;
  reason?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRecordWithPreview extends ScheduleRecord {
  preview: ScheduleOccurrencePreview;
}

export function createWorkflowScheduleLocalizedError(
  key: string,
  message: string,
  values?: Record<string, unknown>,
): ScheduleLocalizedError {
  return Object.assign(new Error(message), {
    name: "ScheduleLocalizedError",
    steamHarnessI18n: {
      namespace: "common" as const,
      key: `schedule.${key}`,
      ...(values === undefined ? {} : { values }),
    },
  });
}

export function getWorkflowScheduleFireReasonI18n(
  reason: string,
): ScheduleI18nDescriptor | undefined {
  const stableKey = STABLE_FIRE_REASON_KEYS[reason];
  if (stableKey !== undefined) {
    return { namespace: "common", key: `schedule.fireReason.${stableKey}` };
  }

  for (const rule of DYNAMIC_FIRE_REASON_RULES) {
    const match = rule.pattern.exec(reason);
    if (match?.groups !== undefined) {
      return {
        namespace: "common",
        key: `schedule.fireReason.${rule.key}`,
        values: match.groups,
      };
    }
  }
  return undefined;
}

export function parseWorkflowSchedulePresets(
  value: unknown,
  projectType: string,
): SchedulePreset[] {
  if (value === undefined) return [];
  if (projectType !== "workflow") {
    throw scheduleError(
      "onlyWorkflowPresets",
      "Only Workflow projects can declare steamHarness.schedulePresets.",
    );
  }
  if (!Array.isArray(value) || value.length > STEAMHARNESS_SCHEDULE_MAX_PRESETS) {
    throw scheduleError(
      "presetsArrayMax",
      `steamHarness.schedulePresets must be an array with at most ${STEAMHARNESS_SCHEDULE_MAX_PRESETS} items.`,
      { max: STEAMHARNESS_SCHEDULE_MAX_PRESETS },
    );
  }

  const ids = new Set<string>();
  return value.map((item, index) => {
    const field = `steamHarness.schedulePresets[${index}]`;
    const record = readRecord(item, field);
    assertOnlyFields(record, field, [
      "id",
      "title",
      "description",
      "entrypointId",
      "timezone",
      "trigger",
      "paramValues",
    ]);
    const id = readString(record.id, `${field}.id`);
    if (!STEAMHARNESS_SCHEDULE_PRESET_ID_PATTERN.test(id)) {
      throw scheduleError("invalidPresetId", `${field}.id is invalid.`, { field: `${field}.id` });
    }
    if (ids.has(id)) {
      throw scheduleError(
        "duplicatePresetId",
        `steamHarness.schedulePresets contains duplicate id "${id}".`,
        { id },
      );
    }
    ids.add(id);

    const title = readBoundedString(record.title, `${field}.title`, STEAMHARNESS_SCHEDULE_NAME_MAX_LENGTH);
    const description = readOptionalBoundedString(record.description, `${field}.description`, 500);
    const entrypointId = readString(record.entrypointId, `${field}.entrypointId`);
    const timezone = validateWorkflowScheduleTimezone(readString(record.timezone, `${field}.timezone`));
    const trigger = parseWorkflowScheduleTrigger(record.trigger, `${field}.trigger`, timezone);
    const paramValues = readRecord(record.paramValues, `${field}.paramValues`);
    assertJsonValue(paramValues, `${field}.paramValues`);

    return {
      id,
      title,
      ...(description === undefined ? {} : { description }),
      entrypointId,
      timezone,
      trigger,
      paramValues,
    };
  });
}

export function parseWorkflowScheduleTrigger(
  value: unknown,
  field = "trigger",
  timezone?: string,
): ScheduleTrigger {
  const record = readRecord(value, field);
  const kind = readString(record.kind, `${field}.kind`);
  if (kind === "cron") {
    assertOnlyFields(record, field, ["kind", "expression"]);
    const expression = readString(record.expression, `${field}.expression`);
    validateFiveFieldCron(expression, timezone);
    return { kind, expression };
  }
  if (kind !== "window-interval") {
    throw scheduleError(
      "invalidTriggerKind",
      `${field}.kind must be "window-interval" or "cron".`,
      { field: `${field}.kind` },
    );
  }

  assertOnlyFields(record, field, ["kind", "weekdays", "windows", "intervalMinutes"]);
  if (!Array.isArray(record.weekdays) || record.weekdays.length === 0) {
    throw scheduleError(
      "weekdaysNonEmpty",
      `${field}.weekdays must be a non-empty array.`,
      { field: `${field}.weekdays` },
    );
  }
  const weekdays = [...new Set(record.weekdays.map((day, index) => {
    if (!Number.isInteger(day) || Number(day) < 1 || Number(day) > 7) {
      const weekdayField = `${field}.weekdays[${index}]`;
      throw scheduleError(
        "weekdayRange",
        `${weekdayField} must be an integer from 1 to 7.`,
        { field: weekdayField },
      );
    }
    return Number(day);
  }))].sort((left, right) => left - right);

  if (
    !Array.isArray(record.windows) ||
    record.windows.length === 0 ||
    record.windows.length > STEAMHARNESS_SCHEDULE_MAX_WINDOWS
  ) {
    throw scheduleError(
      "windowsCount",
      `${field}.windows must contain 1 to ${STEAMHARNESS_SCHEDULE_MAX_WINDOWS} items.`,
      { field: `${field}.windows`, max: STEAMHARNESS_SCHEDULE_MAX_WINDOWS },
    );
  }
  const windows = record.windows.map((window, index) => {
    const windowField = `${field}.windows[${index}]`;
    const windowRecord = readRecord(window, windowField);
    assertOnlyFields(windowRecord, windowField, ["start", "end"]);
    const start = readScheduleTime(windowRecord.start, `${windowField}.start`);
    const end = readScheduleTime(windowRecord.end, `${windowField}.end`);
    if (timeToMinutes(end) < timeToMinutes(start)) {
      throw scheduleError(
        "windowEndBeforeStart",
        `${windowField}.end must not be earlier than start.`,
        { field: `${windowField}.end` },
      );
    }
    return { start, end };
  }).sort((left, right) => timeToMinutes(left.start) - timeToMinutes(right.start));
  for (let index = 1; index < windows.length; index += 1) {
    if (timeToMinutes(windows[index]!.start) <= timeToMinutes(windows[index - 1]!.end)) {
      throw scheduleError(
        "windowsOverlap",
        `${field}.windows must not overlap.`,
        { field: `${field}.windows` },
      );
    }
  }

  const intervalMinutes = record.intervalMinutes;
  if (
    !Number.isInteger(intervalMinutes) ||
    Number(intervalMinutes) < 1 ||
    Number(intervalMinutes) > STEAMHARNESS_SCHEDULE_MAX_INTERVAL_MINUTES
  ) {
    throw scheduleError(
      "intervalRange",
      `${field}.intervalMinutes must be an integer from 1 to ${STEAMHARNESS_SCHEDULE_MAX_INTERVAL_MINUTES}.`,
      { field: `${field}.intervalMinutes`, max: STEAMHARNESS_SCHEDULE_MAX_INTERVAL_MINUTES },
    );
  }
  return { kind, weekdays, windows, intervalMinutes: Number(intervalMinutes) };
}

export function parseWorkflowScheduleInput(value: unknown): ScheduleInput {
  const record = readRecord(value, "schedule");
  assertOnlyFields(record, "schedule", [
    "name",
    "enabled",
    "resolvedTarget",
    "entrypointId",
    "timezone",
    "trigger",
    "paramValues",
  ]);
  const name = readBoundedString(record.name, "schedule.name", STEAMHARNESS_SCHEDULE_NAME_MAX_LENGTH);
  if (typeof record.enabled !== "boolean") {
    throw scheduleError("fieldBoolean", "schedule.enabled must be a boolean.", { field: "schedule.enabled" });
  }
  const resolvedTarget = readString(record.resolvedTarget, "schedule.resolvedTarget");
  const entrypointId = readString(record.entrypointId, "schedule.entrypointId");
  if (!STEAMHARNESS_SCHEDULE_PRESET_ID_PATTERN.test(entrypointId)) {
    throw scheduleError("entrypointInvalid", "schedule.entrypointId is invalid.");
  }
  const timezone = validateWorkflowScheduleTimezone(readString(record.timezone, "schedule.timezone"));
  const trigger = parseWorkflowScheduleTrigger(record.trigger, "schedule.trigger", timezone);
  const paramValues = readRecord(record.paramValues, "schedule.paramValues");
  assertJsonValue(paramValues, "schedule.paramValues");
  return {
    name,
    enabled: record.enabled,
    resolvedTarget,
    entrypointId,
    timezone,
    trigger,
    paramValues,
  };
}

export function validateWorkflowScheduleParamValues(
  paramValues: Record<string, unknown>,
  params: readonly ScheduleParamDefinition[],
  field = "schedule.paramValues",
): void {
  const definitions = new Map(params.map((param) => [param.name, param]));
  const unknown = Object.keys(paramValues).filter((name) => !definitions.has(name));
  if (unknown.length > 0) {
    throw scheduleError(
      "unknownParams",
      `${field} contains unknown parameter(s): ${unknown.join(", ")}.`,
      { field, names: unknown.join(", ") },
    );
  }

  for (const param of params) {
    const value = Object.hasOwn(paramValues, param.name)
      ? paramValues[param.name]
      : param.defaultValue;
    const values = readScheduleParamValues(param, value);
    if (values.length === 0) {
      if (param.required === true) {
        const paramField = `${field}.${param.name}`;
        throw scheduleError("fieldRequired", `${paramField} is required.`, { field: paramField });
      }
      continue;
    }

    for (const item of values) validateScheduleParamValue(param, item, `${field}.${param.name}`);
    if (param.options !== undefined) {
      const allowed = new Set(param.options.map((option) => option.value));
      const invalid = values.map(String).find((item) => !allowed.has(item));
      if (invalid !== undefined) {
        const paramField = `${field}.${param.name}`;
        throw scheduleError(
          "unsupportedOption",
          `${paramField} contains unsupported option "${invalid}".`,
          { field: paramField, value: invalid },
        );
      }
    }
  }
}

export function previewWorkflowSchedule(
  input: Pick<ScheduleInput, "trigger" | "timezone">,
  after: Date | string | number = new Date(),
): ScheduleOccurrencePreview {
  return {
    nextRuns: listNextWorkflowScheduleOccurrences({
      trigger: input.trigger,
      timezone: input.timezone,
      after,
      count: 5,
    }).map((occurrence) => occurrence.toISOString()),
  };
}

export function advanceWorkflowSchedulePastMissed(options: {
  trigger: ScheduleTrigger;
  timezone: string;
  nextFireAt: Date | string | number;
  now: Date | string | number;
}): { missed: boolean; nextFireAt: Date } {
  const nextFireAt = new Date(options.nextFireAt);
  const now = new Date(options.now);
  if (!Number.isFinite(nextFireAt.getTime()) || !Number.isFinite(now.getTime())) {
    throw scheduleError("missedTimestampsInvalid", "Schedule missed-fire timestamps are invalid.");
  }
  if (nextFireAt.getTime() > now.getTime()) return { missed: false, nextFireAt };
  return {
    missed: true,
    nextFireAt: getNextWorkflowScheduleOccurrence({
      trigger: options.trigger,
      timezone: options.timezone,
      after: now,
    }),
  };
}

export function isWorkflowScheduleFireMissed(options: {
  scheduledFor: Date | string | number;
  now: Date | string | number;
  missedAfterMs: number;
}): boolean {
  const scheduledFor = new Date(options.scheduledFor);
  const now = new Date(options.now);
  if (!Number.isFinite(scheduledFor.getTime()) || !Number.isFinite(now.getTime())) {
    throw scheduleError("missedTimestampsInvalid", "Schedule missed-fire timestamps are invalid.");
  }
  if (!Number.isFinite(options.missedAfterMs) || options.missedAfterMs < 0) {
    throw scheduleError(
      "missedThresholdInvalid",
      "Schedule missed-fire threshold must be a non-negative number.",
    );
  }
  return now.getTime() - scheduledFor.getTime() >= options.missedAfterMs;
}

export function validateWorkflowScheduleTimezone(value: string): string {
  const timezone = value.trim();
  if (timezone === "") {
    throw scheduleError("timezoneRequired", "Schedule timezone must be a non-empty IANA timezone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw scheduleError(
      "timezoneInvalid",
      `Schedule timezone "${timezone}" is invalid.`,
      { timezone },
    );
  }
  return timezone;
}

export function listNextWorkflowScheduleOccurrences(options: {
  trigger: ScheduleTrigger;
  timezone: string;
  after: Date | string | number;
  count?: number;
}): Date[] {
  const timezone = validateWorkflowScheduleTimezone(options.timezone);
  const after = new Date(options.after);
  if (!Number.isFinite(after.getTime())) {
    throw scheduleError("occurrenceStartInvalid", "Schedule occurrence start time is invalid.");
  }
  const count = options.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw scheduleError(
      "occurrenceCountInvalid",
      "Schedule occurrence count must be an integer from 1 to 100.",
    );
  }

  const trigger = parseWorkflowScheduleTrigger(options.trigger, "trigger", timezone);
  if (trigger.kind === "cron") {
    const expression = CronExpressionParser.parse(trigger.expression, {
      currentDate: after,
      tz: timezone,
    });
    return Array.from({ length: count }, () => expression.next().toDate());
  }

  return listNextWindowOccurrences(trigger, timezone, after, count);
}

export function getNextWorkflowScheduleOccurrence(options: {
  trigger: ScheduleTrigger;
  timezone: string;
  after: Date | string | number;
}): Date {
  return listNextWorkflowScheduleOccurrences({ ...options, count: 1 })[0]!;
}

function listNextWindowOccurrences(
  trigger: Extract<ScheduleTrigger, { kind: "window-interval" }>,
  timezone: string,
  after: Date,
  count: number,
): Date[] {
  const localAfter = TZDate.tz(timezone, after);
  const results: Date[] = [];
  for (let dayOffset = 0; dayOffset <= 3_700 && results.length < count; dayOffset += 1) {
    const day = TZDate.tz(
      timezone,
      localAfter.getFullYear(),
      localAfter.getMonth(),
      localAfter.getDate() + dayOffset,
    );
    const weekday = day.getDay() === 0 ? 7 : day.getDay();
    if (!trigger.weekdays.includes(weekday)) continue;

    for (const window of trigger.windows) {
      const start = timeToMinutes(window.start);
      const end = timeToMinutes(window.end);
      const minutes = new Set<number>();
      for (let minute = start; minute <= end; minute += trigger.intervalMinutes) minutes.add(minute);
      minutes.add(end);
      for (const minute of [...minutes].sort((left, right) => left - right)) {
        const candidate = TZDate.tz(
          timezone,
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          Math.floor(minute / 60),
          minute % 60,
        );
        if (
          candidate.getFullYear() !== day.getFullYear() ||
          candidate.getMonth() !== day.getMonth() ||
          candidate.getDate() !== day.getDate() ||
          candidate.getHours() !== Math.floor(minute / 60) ||
          candidate.getMinutes() !== minute % 60
        ) continue;
        if (candidate.getTime() <= after.getTime()) continue;
        if (results.at(-1)?.getTime() === candidate.getTime()) continue;
        results.push(new Date(candidate.getTime()));
        if (results.length === count) return results;
      }
    }
  }
  if (results.length < count) {
    throw scheduleError(
      "occurrenceCalculationFailed",
      "Unable to calculate the requested schedule occurrences.",
    );
  }
  return results;
}

function validateFiveFieldCron(expression: string, timezone?: string): void {
  if (expression.trim().split(/\s+/).length !== 5) {
    throw scheduleError("cronFiveFields", "Schedule Cron expression must contain exactly five fields.");
  }
  try {
    CronExpressionParser.parse(expression, {
      currentDate: new Date(),
      ...(timezone === undefined ? {} : { tz: timezone }),
    });
  } catch (error) {
    const details = readErrorMessage(error);
    throw scheduleError(
      "cronInvalid",
      `Schedule Cron expression is invalid: ${details}`,
      { details },
    );
  }
}

function readScheduleParamValues(
  param: ScheduleParamDefinition,
  value: unknown,
): unknown[] {
  if (value === undefined || value === null || value === "") return [];
  const multiple = param.type !== "file" && (param.multiple === true || param.control === "checkboxes");
  if (!multiple) return [value];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // A plain string is a valid one-item multiple value.
    }
  }
  return [value];
}

function validateScheduleParamValue(
  param: ScheduleParamDefinition,
  value: unknown,
  field: string,
): void {
  if (param.type === "file") {
    assertJsonValue(value, field);
    return;
  }
  if (param.type === "number") {
    if ((typeof value !== "string" && typeof value !== "number") || !Number.isFinite(Number(value))) {
      throw scheduleError("fieldNumber", `${field} must be a number.`, { field });
    }
    return;
  }
  if (param.type === "boolean") {
    if (!isScheduleBooleanValue(value)) {
      throw scheduleError("fieldBoolean", `${field} must be a boolean.`, { field });
    }
    return;
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw scheduleError(
      "fieldScalar",
      `${field} must be a string-compatible scalar value.`,
      { field },
    );
  }
  if (isScheduleDateControl(param.control)) {
    if (typeof value !== "string" || !isValidScheduleDateValue(param.control, value)) {
      const format = scheduleDateFormat(param.control);
      throw scheduleError(
        param.control === "date-range" ? "fieldDateRange" : "fieldDateFormat",
        `${field} must use ${format}${param.control === "date-range" ? " with a non-decreasing range" : ""}.`,
        { field, format },
      );
    }
  }
}

function isScheduleBooleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return value === 0 || value === 1;
  return typeof value === "string" && [
    "true",
    "false",
    "1",
    "0",
    "yes",
    "no",
    "on",
    "off",
  ].includes(value.trim().toLowerCase());
}

function isScheduleDateControl(control: string | undefined): control is "date" | "time" | "datetime" | "date-range" {
  return control === "date" || control === "time" || control === "datetime" || control === "date-range";
}

function isValidScheduleDateValue(
  control: "date" | "time" | "datetime" | "date-range",
  value: string,
): boolean {
  if (control === "date") return isValidDate(value);
  if (control === "time") return isValidTime(value);
  if (control === "datetime") {
    return value.length === 19 && value[10] === "T" &&
      isValidDate(value.slice(0, 10)) && isValidTime(value.slice(11));
  }
  const [start, end, extra] = value.split("/");
  return extra === undefined && start !== undefined && end !== undefined &&
    isValidDate(start) && isValidDate(end) && start <= end;
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0);
}

function isValidTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3]) <= 59;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function scheduleDateFormat(control: "date" | "time" | "datetime" | "date-range"): string {
  if (control === "date") return "YYYY-MM-DD";
  if (control === "time") return "HH:mm:ss";
  if (control === "datetime") return "YYYY-MM-DDTHH:mm:ss";
  return "YYYY-MM-DD/YYYY-MM-DD";
}

function readScheduleTime(value: unknown, field: string): string {
  const time = readString(value, field);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw scheduleError("timeFormat", `${field} must use HH:mm.`, { field });
  }
  return time;
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw scheduleError("fieldObject", `${field} must be an object.`, { field });
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw scheduleError("fieldNonEmptyString", `${field} must be a non-empty string.`, { field });
  }
  return value.trim();
}

function readBoundedString(value: unknown, field: string, maxLength: number): string {
  const text = readString(value, field);
  if (text.length > maxLength) {
    throw scheduleError(
      "fieldMaxLength",
      `${field} must not exceed ${maxLength} characters.`,
      { field, max: maxLength },
    );
  }
  return text;
}

function readOptionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return readBoundedString(value, field, maxLength);
}

function assertOnlyFields(record: Record<string, unknown>, field: string, allowed: string[]): void {
  const allowedFields = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedFields.has(key))) {
    throw scheduleError("unsupportedFields", `${field} contains unsupported fields.`, { field });
  }
}

function assertJsonValue(value: unknown, field: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)) {
    throw scheduleError("jsonSerializable", `${field} must be JSON-serializable.`, { field });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonValue(item, `${field}[${index}]`, seen));
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw scheduleError("jsonSerializable", `${field} must be JSON-serializable.`, { field });
    }
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) =>
      assertJsonValue(item, `${field}.${key}`, seen));
  } finally {
    seen.delete(value);
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STABLE_FIRE_REASON_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "Missed triggers were skipped while Desktop was not actively scheduling.": "missedWhileDesktopInactive",
  "Interrupted local schedule fire could not be recovered.": "localRecoveryFailed",
  "Desktop exited before the scheduled Workflow run started.": "desktopExitedBeforeRun",
  "Only Workflow projects can be scheduled.": "workflowProjectRequired",
  'Desktop workflow schedules must use resolvedTarget "dev".': "desktopDevTargetRequired",
  "Unable to inspect the local Workflow structure.": "localStructureUnavailable",
  "Scheduled Workflow did not produce a run record.": "runRecordMissing",
});

const DYNAMIC_FIRE_REASON_RULES: ReadonlyArray<{
  key: string;
  pattern: RegExp;
}> = [
  {
    key: "previousLocalFireActive",
    pattern: /^Previous fire "(?<fireId>[^"]+)" is still (?<status>[^.]+)\.$/,
  },
  {
    key: "runFinishedWithStatus",
    pattern: /^Run finished with status "(?<status>[^"]+)"\.$/,
  },
  {
    key: "entrypointMissing",
    pattern: /^Entrypoint "?(?<entrypointId>[^" ]+)"? no longer exists(?: in the local Workflow source)?\.$/,
  },
  {
    key: "unknownEntrypoint",
    pattern: /^Unknown entrypoint "(?<entrypointId>[^"]*)" for workflow "(?<workflowId>[^"]+)"\.$/,
  },
  {
    key: "dependenciesMissing",
    pattern: /^Workflow project dependencies are not installed\.\nProject: (?<projectPath>[^\n]+)\nMissing: (?<missing>[^\n]+)\nInstall dependencies manually in this project directory before running it\. SteamHarness will not install or modify dependencies\.$/,
  },
];

function scheduleError(
  key: string,
  message: string,
  values?: Record<string, unknown>,
): ScheduleLocalizedError {
  return createWorkflowScheduleLocalizedError(`validation.${key}`, message, values);
}
