import { useState } from 'react';
import { useTranslation } from '@steamharness/i18n/react';
import { ProjectOwnership } from '@/components/ProjectOwnership';
import { ConfirmActionDialog, type ConfirmAction } from '@/components/ConfirmActionDialog';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Field, FieldGroup, FieldLabel, FieldDescription, Switch } from '@/components/ui';
import type { DetailPageProps } from './types';
export function ProjectSettingsTab({project,busy,onUpdateVisibility,onRefresh}:DetailPageProps){
  const {t}=useTranslation('serverWeb');const [action,setAction]=useState<ConfirmAction|null>(null);
  return <div className="flex flex-col gap-4 p-6"><Card><CardHeader><CardTitle>{t('projectSettingsAccessPolicy')}</CardTitle><CardDescription>{project.name}</CardDescription></CardHeader><CardContent>
    <FieldGroup><Field orientation="horizontal"><FieldLabel htmlFor="project-public">{t('storagePublicProject')}</FieldLabel><FieldDescription>{t('storagePublicProjectDescription')}</FieldDescription><Switch id="project-public" checked={project.visibility==='public'} disabled={!!busy.project||!project.access?.capabilities.includes('manageSettings')} onCheckedChange={checked=>setAction({title:t(checked?'projectSettingsSetPublicConfirm':'projectSettingsSetPrivateConfirm'),description:t(checked?'projectSettingsSetPublicConfirmDescription':'projectSettingsSetPrivateConfirmDescription'),confirmLabel:t('commonSave'),tone:'warning',onConfirm:()=>onUpdateVisibility(checked?'public':'private')})}/></Field></FieldGroup>
  </CardContent></Card><ProjectOwnership project={project} onRefresh={onRefresh}/><ConfirmActionDialog action={action} onOpenChange={open=>{if(!open)setAction(null);}}/></div>;
}
