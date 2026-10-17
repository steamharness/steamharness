export function getEnv(name: string): string | undefined {
  const key = name.trim();
  if (key === "") {
    return undefined;
  }

  const value = process.env[key];
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}
