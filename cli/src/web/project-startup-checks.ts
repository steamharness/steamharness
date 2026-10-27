import { readServerProject, type ProjectServerCheck, type ProjectServerInspector } from './project-server-state';
import type { Project } from './workflow-types';
/** Database readiness is entry-specific and never prevents the aggregate host from starting. */
export function projectStartupInspector(project: Project, verify: (alias:string)=>Promise<unknown>, refresh: () => Promise<void> = async () => {}): ProjectServerInspector {
  return async (connection, signal, publish, unavailable) => {
    await refresh();
    const checks: ProjectServerCheck[] = [];
    if (project.databases.some(database => database.host === 'server')) {
      const issue = connection ? (await readServerProject(project.id, connection, signal)).issue : unavailable;
      checks.push({ id: 'project', projectId: project.id, entryId: project.entryId, stage: 'registration', status: issue ? 'action-required' : 'passed', issue });
    }
    for (const database of project.databases) {
      let issue: ProjectServerCheck['issue'];
      try { await verify(database.alias); }
      catch { issue = {kind:'setup-required',projectId:project.id,entryId:project.entryId,database:database.alias}; }
      if (signal.aborted) return checks;
      checks.push({id:`database:${database.alias}`,projectId:project.id,entryId:project.entryId,database:database.alias,stage:'database',status:issue?'action-required':'passed',issue});
    }
    publish(checks); return checks;
  };
}
