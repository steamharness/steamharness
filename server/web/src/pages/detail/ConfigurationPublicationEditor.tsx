import {useRef,useState} from 'react';
import {useTranslation} from '@steamharness/i18n/react';
import {configurationSnapshot,createPublicationDraft,freezeConfigurationTemplate,configurationRule,type ConfigurationPublicationDraft,type ProjectConfigurationState,type ConfigurationSharingRule,type ProjectConfigurationField} from '@steamharness/project-configuration';
import {Alert,AlertDescription,Button,Checkbox,Field,FieldDescription,FieldGroup,FieldLabel,FieldSet,FieldLegend,Input,SelectField,Separator,Textarea} from '@/components/ui';

export function ConfigurationPublicationEditor({state,busy,onSave}:{state:ProjectConfigurationState;busy:boolean;onSave(draft:ConfigurationPublicationDraft):Promise<boolean|undefined>}) {
  const {t}=useTranslation('serverWeb');
  const [draft,setDraft]=useState(()=>structuredClone(state.publication??createPublicationDraft(state)));
  const initial=useRef(draft),[error,setError]=useState(''),[preview,setPreview]=useState('');
  const update=(next:ConfigurationPublicationDraft)=>{setDraft(next);setPreview('');};
  const editField=(index:number,field:ProjectConfigurationField)=>update({...draft,fields:draft.fields.map((old,i)=>i===index?field:old)});
  const ruleControl=(field:ProjectConfigurationField,index:number,key:keyof ConfigurationSharingRule)=>{
    const rule=configurationRule(field);
    return <Field key={key} orientation="horizontal"><Checkbox id={`publication-${field.name}-${key}`} disabled={busy} checked={rule[key]} onCheckedChange={checked=>editField(index,{...field,sharing:{...field.sharing,[key]:!!checked}})}/><FieldLabel htmlFor={`publication-${field.name}-${key}`}>{t(`configurationRule_${key}`)}</FieldLabel></Field>;
  };
  function showPreview() {
    try {setError('');const template=freezeConfigurationTemplate(draft,{projectId:'preview',projectVersion:'preview',sourceHash:'0'.repeat(64)});setPreview(JSON.stringify(template,null,2));}
    catch(error){setError((error as Error).message);}
  }
  const available=[...state.configurations,...draft.configurations.filter(profile=>!state.configurations.some(c=>c.id===profile.id))];
  return <FieldGroup>
    <FieldDescription>{t('configurationPublicationHelp')}</FieldDescription>
    {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {state.publication&&state.publication.revision!==initial.current.revision&&<Alert><AlertDescription>{t('configurationConflict')}</AlertDescription></Alert>}
    <FieldSet disabled={busy}><FieldLegend>{t('configurationPublishedProfiles')}</FieldLegend>
      {available.map(profile=><Field key={profile.id} orientation="horizontal"><Checkbox id={`publish-profile-${profile.id}`} checked={draft.configurations.some(c=>c.id===profile.id)} onCheckedChange={checked=>{
        const configurations=checked?[...draft.configurations,{id:profile.id,name:profile.name,values:state.configurations.some(c=>c.id===profile.id)?configurationSnapshot(state,profile.id,false).values:profile.values}]:draft.configurations.filter(c=>c.id!==profile.id);
        update({...draft,configurations,defaultConfigurationId:configurations.some(c=>c.id===draft.defaultConfigurationId)?draft.defaultConfigurationId:configurations[0]?.id??''});
      }}/><FieldLabel htmlFor={`publish-profile-${profile.id}`}>{profile.name}</FieldLabel></Field>)}
      <Field><FieldLabel htmlFor="publication-default">{t('configurationPublishedDefault')}</FieldLabel><SelectField id="publication-default" disabled={busy||!draft.configurations.length} value={draft.defaultConfigurationId} options={draft.configurations.map(c=>({value:c.id,label:c.name}))} onValueChange={defaultConfigurationId=>update({...draft,defaultConfigurationId})}/></Field>
      <Button variant="outline" disabled={busy} onClick={()=>update({...draft,configurationRevision:state.revision,configurations:draft.configurations.map(profile=>({...profile,values:state.configurations.some(c=>c.id===profile.id)?configurationSnapshot(state,profile.id,false).values:profile.values}))})}>{t('configurationRefreshPublishedValues')}</Button>
    </FieldSet><Button variant="outline" disabled={busy} onClick={()=>update({...draft,fields:state.fields.map(field=>({...field,sharing:draft.fields.find(old=>old.name===field.name)?.sharing??field.sharing,paths:draft.fields.find(old=>old.name===field.name)?.paths??field.paths}))})}>{t('configurationRefreshPublishedFields')}</Button><Separator/>
    {draft.fields.map((field,index)=><FieldSet key={field.name} disabled={busy}><FieldLegend>{field.label||field.name}</FieldLegend>
      <div className="flex flex-wrap gap-4">{(['publish','includeValue','editable'] as const).map(key=>ruleControl(field,index,key))}</div>
      {field.type==='json'&&<JsonPathRules field={field} onChange={field=>editField(index,field)} disabled={busy}/>}
    </FieldSet>)}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={showPreview}>{t('configurationRecipientPreview')}</Button><Button disabled={busy} onClick={()=>{
      try {freezeConfigurationTemplate(draft,{projectId:'preview',projectVersion:'preview',sourceHash:'0'.repeat(64)});setError('');void onSave(draft).then(saved=>{if(saved){const next={...draft,revision:draft.revision+1};initial.current=next;setDraft(next);}});}catch(error){setError((error as Error).message);}
    }}>{t('configurationSavePublication')}</Button></div>
    {preview&&<Field><FieldLabel htmlFor="publication-recipient-preview">{t('configurationRecipientPreview')}</FieldLabel><Textarea id="publication-recipient-preview" rows={12} readOnly value={preview}/></Field>}
  </FieldGroup>;
}
function JsonPathRules({field,onChange,disabled}:{field:ProjectConfigurationField;onChange(field:ProjectConfigurationField):void;disabled:boolean}) {
  const {t}=useTranslation('serverWeb'),[pointer,setPointer]=useState('');
  return <FieldGroup>
    {Object.entries(field.paths??{}).map(([path,rule])=><Field key={path}><FieldLabel>{path}</FieldLabel><div className="flex flex-wrap gap-2">
      {(['publish','includeValue','editable'] as const).map(key=><Field key={key}><FieldLabel>{t(`configurationRule_${key}`)}</FieldLabel><SelectField disabled={disabled} value={rule[key]===undefined?'inherit':String(rule[key])} options={[{value:'inherit',label:t('configurationInherit')},{value:'true',label:t('configurationYes')},{value:'false',label:t('configurationNo')}]} onValueChange={value=>{
        const next={...rule};if(value==='inherit')delete next[key];else next[key]=value==='true';onChange({...field,paths:{...field.paths,[path]:next}});
      }}/></Field>)}
      <Button variant="ghost" disabled={disabled} onClick={()=>{const paths={...field.paths};delete paths[path];onChange({...field,paths});}}>{t('configurationDeletePath')}</Button>
    </div></Field>)}
    <Field><FieldLabel>{t('configurationJsonPointer')}</FieldLabel><div className="flex gap-2"><Input disabled={disabled} value={pointer} placeholder="/connection/host" onChange={event=>setPointer(event.target.value)}/><Button variant="outline" disabled={disabled||!pointer.startsWith('/')} onClick={()=>{onChange({...field,paths:{...field.paths,[pointer]:{}}});setPointer('');}}>{t('configurationAddPath')}</Button></div></Field>
  </FieldGroup>;
}
