import corePackage from "../package.json" with { type: "json" };
import type { ProjectEntry } from "@steamharness/project-manifest";

export interface ProjectRuntimeHost {
  kind: "cli" | "cli-web" | "studio" | "openai-responses";
  cliVersion?: string;
}

export interface ProjectRuntimeInfo {
  host?: ProjectRuntimeHost;
  project: {
    name: string;
    version?: string;
    directory: string;
    entry: Pick<ProjectEntry, "entryId" | "name" | "type">;
  };
}

export function readAgentRuntimeInfo(workdir: string, info?: ProjectRuntimeInfo) {
  const { project, ...runtime } = readRuntimeInfo("agent", info);
  return { ...runtime, workdir, ...(project && info && { project: { ...project, directory: info.project.directory } }) };
}

export function readRuntimeInfo(engine: "agent" | "llm", info?: ProjectRuntimeInfo) {
  const { host, project } = info ?? {};
  return {
    engine,
    coreVersion: corePackage.version,
    ...(host && { host: { kind: host.kind, ...(host.cliVersion !== undefined && { cliVersion: host.cliVersion }) } }),
    runtime: {
      name: "node",
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      ...(process.versions.electron !== undefined && { electronVersion: process.versions.electron }),
    },
    ...(project && { project: {
      name: project.name,
      ...(project.version !== undefined && { version: project.version }),
      entry: { entryId: project.entry.entryId, name: project.entry.name, type: project.entry.type },
    } }),
  };
}
