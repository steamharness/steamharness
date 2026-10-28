import { useEffect, useState } from 'react';
import { LayoutDashboard, Layers, Database, Settings2, Package, Users, Mail, type LucideIcon } from 'lucide-react';
import type { ServerWebResourceKey } from '@steamharness/i18n';
import { useTranslation } from '@steamharness/i18n/react';
import { SelectField } from '@/components/ui';
import type { DetailTab } from '../state';
import type { Summary } from '../types';
import { ProjectOverviewTab } from './detail/ProjectOverviewTab';
import { ProjectSettingsTab } from './detail/ProjectSettingsTab';
import { ProjectMembersTab } from './detail/ProjectMembersTab';
import { ProjectInvitationsTab } from './detail/ProjectInvitationsTab';
import { ProjectConfigurationsTab } from './detail/ProjectConfigurationsTab';
import { VersionsTab } from './detail/VersionsTab';
import { DatabaseSpacesPage } from './DatabaseSpacesPage';
import type { DetailPageProps } from './detail/types';
export type { DetailPageProps } from './detail/types';
export const DETAIL_NAV_GROUPS: Array<{id:string;label:ServerWebResourceKey;items:Array<{tab:DetailTab;label:ServerWebResourceKey;icon:LucideIcon}>}> = [
  {id:'project',label:'projectSettingsProjectInfo',items:[
    {tab:'project',label:'detailNavOverview',icon:LayoutDashboard},
    {tab:'entries',label:'aggregateEntries',icon:Layers},
    {tab:'configurations',label:'projectConfigurations',icon:Settings2},
    {tab:'databases',label:'databaseSpaces',icon:Database},
    {tab:'settings',label:'detailNavSettings',icon:Settings2},
    {tab:'versions',label:'detailNavVersions',icon:Package},
  ]},
  {id:'members',label:'detailNavMembers',items:[{tab:'members',label:'detailNavMembers',icon:Users},{tab:'invitations',label:'storageInvitations',icon:Mail}]},
];
export function getDetailNavGroups(project: Pick<Summary,'access'> | undefined) { return project?DETAIL_NAV_GROUPS.map(group=>({...group,items:group.items.filter(item=>item.tab!=='invitations'||project.access?.capabilities.includes('manageMembers'))})):[]; }
export function getDetailNavItems(project:Pick<Summary,'access'>|undefined){return getDetailNavGroups(project).flatMap(group=>group.items);}
export function resolveDetailTab(project:Pick<Summary,'access'>,requested:DetailTab):DetailTab{return getDetailNavItems(project).some(item=>item.tab===requested)?requested:'project';}
export function DetailPage(props:DetailPageProps){
  const {t}=useTranslation('serverWeb');
  const [entryId,setEntryId]=useState(props.entryId ?? props.project.defaultEntry);
  useEffect(() => { setEntryId(props.project.entries.some(entry => entry.entryId === props.entryId) ? props.entryId! : props.project.defaultEntry); }, [props.project.id, props.project.defaultEntry, props.entryId]);
  const active=resolveDetailTab(props.project,props.activeTab);
  return <div className="flex h-full min-h-0 flex-col overflow-auto">
    {(active==='project'||active==='entries')&&<ProjectOverviewTab {...props}/>}
    {active==='settings'&&<ProjectSettingsTab {...props}/>}
    {active==='members'&&<ProjectMembersTab {...props}/>}
    {active==='invitations'&&<ProjectInvitationsTab {...props}/>}
    {active==='versions'&&<VersionsTab {...props}/>}
    {active==='databases'&&<DatabaseSpacesPage project={props.project}/>}
    {active==='configurations'&&<><div className="p-4"><SelectField aria-label={t('aggregateEntries')} value={entryId} onValueChange={value => { setEntryId(value); props.onSelectEntry?.(value); }} options={props.project.entries.map(entry=>({value:entry.entryId,label:`${entry.name} · ${entry.type}`}))}/></div><ProjectConfigurationsTab key={`${props.project.id}/${entryId}`} project={props.project} entryId={entryId}/></>}
  </div>;
}
