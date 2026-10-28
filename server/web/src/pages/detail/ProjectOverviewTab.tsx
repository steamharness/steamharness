import { useTranslation } from '@steamharness/i18n/react';
import { Badge, Card, CardHeader, CardTitle, CardDescription, CardContent, TablePanel, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui';
import { getProjectDisplayName } from '@/utils/project-presentation';
import type { DetailPageProps } from './types';
import { ProjectAvatar } from '@/components/ProjectAvatar';
export function ProjectOverviewTab({project}:DetailPageProps){
  const {t,i18n}=useTranslation('serverWeb');
  return <div className="flex flex-col gap-4 p-6"><Card>
    <CardHeader><CardTitle>{getProjectDisplayName(project,i18n.language)}</CardTitle><CardDescription>{project.id}</CardDescription></CardHeader>
    <CardContent><p>{t('aggregateDefaultEntry')}: {project.defaultEntry}</p></CardContent>
  </Card><Card><CardHeader><CardTitle>{t('aggregateEntries')}</CardTitle><CardDescription>{t('aggregateEntriesDescription')}</CardDescription></CardHeader><CardContent>
    <TablePanel><TableHeader><TableRow><TableHead>{t('aggregateEntryId')}</TableHead><TableHead>{t('projectSettingsDefaultName')}</TableHead><TableHead>{t('aggregateEntryType')}</TableHead><TableHead>{t('aggregateEntryPath')}</TableHead><TableHead>{t('databaseRequirements')}</TableHead></TableRow></TableHeader><TableBody>
      {project.entries.map(entry=><TableRow key={entry.entryId}><TableCell>{entry.entryId}</TableCell><TableCell><div className="flex items-center gap-3"><ProjectAvatar card={entry.projectCard} projectType={entry.type} label={entry.name} /><span>{entry.name}</span></div></TableCell><TableCell><Badge variant="outline">{entry.type}</Badge></TableCell><TableCell><code>{entry.root}/{entry.entry}</code></TableCell><TableCell>{entry.databases.map(database=><p key={database.alias}>{database.alias} · {database.databaseId}</p>)}</TableCell></TableRow>)}
    </TableBody></TablePanel>
  </CardContent></Card></div>;
}
