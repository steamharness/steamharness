/** Project-owned outputs share one namespace under the aggregate root's dist directory. */
export const PROJECT_ARTIFACT_DIRECTORY = "dist/steamharness";
export const DATABASE_GENERATED_DIRECTORY = `${PROJECT_ARTIFACT_DIRECTORY}/generated/database`;
export const PROJECT_CACHE_DIRECTORY = `${PROJECT_ARTIFACT_DIRECTORY}/cache`;
export const PROJECT_REPORTS_DIRECTORY = `${PROJECT_ARTIFACT_DIRECTORY}/reports`;
export const PROJECT_RELEASE_BASE_DIRECTORY = `${PROJECT_ARTIFACT_DIRECTORY}/release`;
export const PROJECT_TEMP_DIRECTORY = `${PROJECT_ARTIFACT_DIRECTORY}/tmp`;

/** Tool work directories are never distributable project assets. */
export function isProjectToolArtifactPath(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/").toLowerCase();
  return [PROJECT_CACHE_DIRECTORY, PROJECT_REPORTS_DIRECTORY, PROJECT_RELEASE_BASE_DIRECTORY, PROJECT_TEMP_DIRECTORY]
    .some(directory => normalized === directory || normalized.startsWith(directory + "/"));
}
