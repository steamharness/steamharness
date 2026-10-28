import * as vscode from 'vscode';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { t } from './localization';
import { projectDisplayName, projectTypeLabels, projectVersion, projectWindowKey, type Project } from './workflow-types';

type ProjectWindowNode = Project & { aggregateNode?: true };
const sameProject = (left: Project, right: Project): boolean => left.uri === right.uri && left.id === right.id;

/** A view of the current project's entries, independent of the full resource catalog. */
export class ProjectWindowsProvider implements vscode.TreeDataProvider<ProjectWindowNode>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  private entries: Project[] = [];
  private published = '';

  update(projects: Project[], preferred?: Project): void {
    const previous = this.entries[0];
    // Focusing tools or the built-in assistant must not switch to another workspace project.
    const current = (preferred && projects.find(project => sameProject(project, preferred)))
      ?? (previous && projects.find(project => sameProject(project, previous))) ?? projects[0];
    this.entries = current ? projects.filter(project => sameProject(project, current)) : [];
    const signature = JSON.stringify(this.entries.map(({ uri, id, entryId, name, aggregateName, projectType, projectCard, aggregateProjectCard, defaultEntry, entries, folderPath, manifest }) =>
      ({ uri, id, entryId, name, aggregateName, projectType, projectCard, aggregateProjectCard, defaultEntry, entries, folderPath, version: manifest?.version })));
    if (signature === this.published) { return; }
    this.published = signature;
    this.change.fire();
  }

  getChildren(node?: ProjectWindowNode): ProjectWindowNode[] {
    if (node) { return node.aggregateNode ? this.entries.filter(project => sameProject(project, node)) : []; }
    const project = this.entries[0];
    return project ? [{ ...project, aggregateNode: true }] : [];
  }

  getTreeItem(project: ProjectWindowNode): vscode.TreeItem {
    const aggregate = !!project.aggregateNode;
    const item = new vscode.TreeItem(aggregate ? project.aggregateName : project.name,
      aggregate ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = aggregate ? `${project.uri}#project=${project.id}` : projectWindowKey(project);
    item.description = aggregate ? projectVersion(project) : projectTypeLabels[project.projectType];
    item.tooltip = `${aggregate ? project.aggregateName : projectDisplayName(project)}\n${project.folderPath}`;
    item.contextValue = aggregate ? 'studio.projectWindowAggregate' : 'studio.projectWindowEntry';
    item.iconPath = vscode.Uri.parse(projectAvatarDataUrl(aggregate ? project.aggregateProjectCard : project.projectCard,
      aggregate ? project.entries.find(entry => entry.entryId === project.defaultEntry)?.type ?? project.projectType : project.projectType));
    if (!aggregate) {
      item.command = { command: 'studio.openProjectWindow', title: t('Open Project Window'), arguments: [project] };
    }
    return item;
  }

  dispose(): void { this.change.dispose(); }
}
