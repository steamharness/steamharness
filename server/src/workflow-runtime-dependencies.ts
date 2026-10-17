export const WORKFLOW_PROJECT_CORE_VERSION = "0.2.0";
export const WORKFLOW_PROJECT_CLI_VERSION = "0.2.0";

export function upgradeWorkflowRuntimeDependencies(
  packageJson: Record<string, unknown>,
): Record<string, unknown> {
  const nextPackageJson = { ...packageJson };
  const dependencies = isRecord(nextPackageJson.dependencies)
    ? { ...nextPackageJson.dependencies }
    : undefined;
  const devDependencies = isRecord(nextPackageJson.devDependencies)
    ? { ...nextPackageJson.devDependencies }
    : {};

  for (const [dependencyName, version] of [
    ["workflow-code", WORKFLOW_PROJECT_CORE_VERSION],
    ["@workflow-code/cli", WORKFLOW_PROJECT_CLI_VERSION],
  ] as const) {
    if (dependencies !== undefined) delete dependencies[dependencyName];
    devDependencies[dependencyName] = version;
  }

  if (dependencies !== undefined) nextPackageJson.dependencies = dependencies;
  nextPackageJson.devDependencies = devDependencies;
  return nextPackageJson;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
