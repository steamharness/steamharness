import { readServerProject, type ProjectServerCheck, type ProjectServerInspector } from './project-server-state';
import type { Project } from './workflow-types';
/** Database readiness is entry-specific and never prevents the aggregate host from starting. */
export function projectStartupInspector(project: Project, verify: (alias:string, kind?: 'databases' | 'knowledge-bases')=>Promise<unknown>, refresh: () => Promise<void> = async () => {}): ProjectServerInspector {
  return async (connection, signal, publish, unavailable) => {
    await refresh();
    let server = false;
    const checks: ProjectServerCheck[] = await Promise.all([...project.databases.map(alias => ({alias,kind:'databases' as const})), ...(project.knowledgeBases ?? []).map(item => ({...item,kind:'knowledge-bases' as const}))].map(async database => {
      let issue: ProjectServerCheck['issue'];
      try { const authorization = await verify(database.alias, database.kind) as { space?: { host?: string } } | undefined; server ||= authorization?.space?.host === 'server'; }
      catch (error) { server ||= (error as { metadata?: { host?: string } }).metadata?.host === 'server'; issue = {kind:'setup-required',projectId:project.id,entryId:project.entryId,database:database.alias}; }
      return {id:`${database.kind}:${database.alias}`,projectId:project.id,entryId:project.entryId,database:database.alias,stage:'database',status:issue?'action-required':'passed',issue} satisfies ProjectServerCheck;
    }));
    if (signal.aborted) return checks;
    if (server) {
      const issue = connection ? (await readServerProject(project.id, connection, signal)).issue : unavailable;
      checks.unshift({ id: 'project', projectId: project.id, entryId: project.entryId, stage: 'registration', status: issue ? 'action-required' : 'passed', issue });
    }
    publish(checks); return checks;
  };
}
