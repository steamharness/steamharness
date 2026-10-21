import {LockIcon,XIcon} from 'lucide-react';
import {useRef} from 'react';
import {useTranslation} from '@steamharness/i18n/react';
import {configurationCapability,configurationPointerPart,type ConfigurationValue,type ProjectConfigurationField,type ProjectConfigurationState} from '@steamharness/project-configuration';
import {Button,Field,FieldGroup,FieldLabel,Input,Textarea} from '@/components/ui';
export function ConfigurationJsonInput({state,field,value,busy,onChange}:{state:ProjectConfigurationState;field:ProjectConfigurationField;value:string;busy:boolean;onChange(value:string):void}) {
  const {t}=useTranslation('serverWeb');
  const lastObject=useRef<ConfigurationValue>(undefined);
  const canEdit=configurationCapability(state,field).editable||Object.keys(field.paths??{}).some(path=>configurationCapability(state,field,path).editable);
  let parsed:ConfigurationValue;try{parsed=JSON.parse(value);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))lastObject.current=parsed;}catch{if(lastObject.current)parsed=lastObject.current;else return <Textarea id={`configuration-${field.name}`} aria-label={field.label||field.name} disabled={busy||!canEdit} value={value} onChange={event=>onChange(event.target.value)}/>;}
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) return <Textarea id={`configuration-${field.name}`} aria-label={field.label||field.name} disabled={busy||!configurationCapability(state,field).editable} rows={4} value={value} onChange={event=>onChange(event.target.value)}/>;
  const replace=(parts:string[],next:ConfigurationValue|undefined)=>{
    const copy=structuredClone(parsed);let parent=copy as Record<string,ConfigurationValue>;
    for(const part of parts.slice(0,-1))parent=parent[part] as Record<string,ConfigurationValue>;
    if(!parts.length){onChange(JSON.stringify(next));return;}
    if(next===undefined)delete parent[parts.at(-1)!];else parent[parts.at(-1)!]=next;
    onChange(JSON.stringify(copy,null,2));
  };
  const walk=(item:ConfigurationValue,parts:string[]=[]):React.ReactNode=>{
    const pointer=parts.map(key=>`/${configurationPointerPart(key)}`).join(''),cap=configurationCapability(state,field,pointer);
    if(item&&typeof item==='object'&&!Array.isArray(item))return <FieldGroup key={pointer}>{Object.entries(item).map(([key,entry])=>walk(entry,[...parts,key]))}</FieldGroup>;
    return <Field key={pointer}><FieldLabel>{pointer||field.label||field.name}{!cap.editable&&<LockIcon aria-label={t('configurationLocked')}/>}</FieldLabel><div className="flex gap-2"><Input aria-label={pointer||field.name} disabled={busy||!cap.editable} defaultValue={typeof item==='string'?item:JSON.stringify(item)} key={JSON.stringify(item)} onBlur={event=>{try{replace(parts,typeof item==='string'?event.target.value:JSON.parse(event.target.value));}catch{event.currentTarget.value=typeof item==='string'?item:JSON.stringify(item);}}}/>{parts.length>0&&<Button variant="ghost" size="icon" disabled={busy||!cap.editable} title={t('configurationDeletePath')} aria-label={t('configurationDeletePath')} onClick={()=>replace(parts,undefined)}><XIcon/></Button>}</div></Field>;
  };
  return <FieldGroup>{walk(parsed)}<details><summary>{t('configurationRawJson')}</summary><Textarea id={`configuration-${field.name}`} aria-label={t('configurationRawJson')} disabled={busy||!canEdit} rows={4} value={value} onChange={event=>onChange(event.target.value)}/></details></FieldGroup>;
}
