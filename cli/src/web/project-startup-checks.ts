import { isProjectDataStorageLocationAllowed, readProjectInfo, resolveProjectRelatedProjectAccess, type ProjectInfoContract } from '@steamharness/project-info';
import { readServerProject, type ProjectServerCheck, type ProjectServerInspector, type ProjectServerIssue } from './project-server-state';
import type { RelatedProjectImports } from './related-projects';
import type { Project } from './workflow-types';

/** One read-only lifecycle pass. A missing import always precedes Server diagnostics. */
export function projectStartupInspector(project: Project, imports: RelatedProjectImports): ProjectServerInspector {
  return async (connection, signal, publish, unavailable) => {
    const relations = [...(project.projectInfo?.relatedProjects ?? [])];
    let checks: ProjectServerCheck[] = [
      { id: 'project', projectId: project.id, stage: 'registration', status: 'checking' },
      ...relations.map(relation => {
        const issue = imports.missingIssue(relation.alias, project);
        return { id: `related:${relation.alias}`, projectId: relation.projectId, relatedProjectAlias: relation.alias,
          stage: issue ? 'import' as const : 'registration' as const, status: issue ? 'action-required' as const : 'waiting' as const, issue };
      }),
    ];
    const update = (id: string, change: Partial<ProjectServerCheck>) => {
      checks = checks.map(check => check.id === id ? { ...check, ...change } : check);
      if (!signal.aborted) publish(checks);
    };
    publish(checks);
    if (!connection) {
      update('project', { status: 'action-required', issue: unavailable });
      return checks;
    }
    const read = async (projectId: string) => {
      try { return await readServerProject(projectId, connection, signal); }
      catch { return { issue: { kind: 'connection-unavailable' as const, serverUrl: connection.serverUrl } }; }
    };
    const current = await read(project.id);
    if (signal.aborted) return checks;
    let currentIssue = current.issue;
    if (!currentIssue && project.projectInfo?.dataStorage?.mode === 'server' && current.project?.projectInfo) {
      try {
        if (!isProjectDataStorageLocationAllowed(readProjectInfo({ steamHarness: { projectInfo: current.project.projectInfo } }), 'server')) currentIssue = { kind: 'setup-required', serverUrl: connection.serverUrl };
      } catch { currentIssue = { kind: 'setup-required', serverUrl: connection.serverUrl }; }
    }
    update('project', { status: currentIssue ? 'action-required' : 'passed', issue: currentIssue });
    // Import results are useful even when the current registration is missing;
    // dependent Server checks wait until that prerequisite is available.
    if (currentIssue) return checks;
    const pending = relations.filter(relation => !checks.find(check => check.id === `related:${relation.alias}`)?.issue);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (!signal.aborted && cursor < pending.length) {
        const relation = pending[cursor++], id = `related:${relation.alias}`;
        const scoped = (issue: ProjectServerIssue): ProjectServerIssue => imports.issue({ ...issue,
          projectId: relation.projectId, relatedProjectAlias: relation.alias })!;
        update(id, { status: 'checking' });
        const target = await read(relation.projectId);
        if (signal.aborted) return;
        if (target.issue) { update(id, { status: 'action-required', issue: scoped(target.issue) }); continue; }
        update(id, { stage: 'relationship' });
        let issue: ProjectServerIssue | undefined;
        const local = imports.localProject(relation.alias, relation.projectId);
        const relatedIssue = () => scoped({ kind: 'related-setup-required', serverUrl: connection.serverUrl });
        if (local && !relationship(project.projectInfo, local.projectInfo, relation.alias, relation.projectId, project.id)) issue = relatedIssue();
        // Local declarations authorize local access. Server declarations govern
        // Server access; registration alone does not establish either grant.
        if (!issue && project.projectInfo?.dataStorage?.mode !== 'local') {
          try {
            const consumerInfo = readProjectInfo({ steamHarness: { projectInfo: current.project?.projectInfo } });
            const targetInfo = readProjectInfo({ steamHarness: { projectInfo: target.project?.projectInfo } });
            if (!relationship(consumerInfo, targetInfo, relation.alias, relation.projectId, project.id, 'server')) issue = relatedIssue();
          } catch { issue = relatedIssue(); }
        }
        update(id, { status: issue ? 'action-required' : 'passed', issue });
      }
    }));
    return checks;
  };
}

function relationship(consumer: ProjectInfoContract | undefined, target: ProjectInfoContract | undefined,
  alias: string, targetProjectId: string, consumerProjectId: string, location?: 'server'): boolean {
  if (!consumer || !target || !resolveProjectRelatedProjectAccess({ consumerProjectId, consumerProjectInfo: consumer, targetProjectId, targetProjectInfo: target, alias })) return false;
  const locations = location ? [location] as const : ['local', 'server'] as const;
  return locations.some(location => isProjectDataStorageLocationAllowed(consumer, location) && isProjectDataStorageLocationAllowed(target, location));
}
