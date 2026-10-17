const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DateTimeFilterBoundary = "start" | "end";

export function normalizeDateTimeFilter(
  value: string,
  boundary: DateTimeFilterBoundary = "start",
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = DATE_ONLY_PATTERN.test(trimmed)
    ? `${trimmed}T${boundary === "end" ? "23:59:59.999" : "00:00:00.000"}Z`
    : trimmed;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}
