import { describe, expect, it } from 'vitest';
import { AGENT_MEMORY_CONFIGURATION_FIELD as field, AGENT_MEMORY_CONFIGURATION_KEY as key, applyConfigurationAction, bindConfigurationTemplate, configurationSnapshot, createConfigurationState, createPublicationDraft, exportConfigurations, freezeConfigurationTemplate, parseConfigurationField } from '../index';

describe('project memory opt-in',()=>{
 it('defaults off and preserves explicit on/off through profiles, exports and publication',()=>{
  let state=createConfigurationState([field],()=> 'profile');
  expect(configurationSnapshot(state).values[key]).toBe(false);
  for(const enabled of [true,false]){
   state=applyConfigurationAction(state,{action:'save',revision:state.revision,id:state.activeConfigurationId,values:{[key]:enabled}},()=> 'unused');
   const template=freezeConfigurationTemplate(createPublicationDraft(state),{projectId:'project',entryId:'main',projectVersion:'1.0.0',sourceHash:'0'.repeat(64)});
   const recipient=bindConfigurationTemplate(createConfigurationState([],()=> 'personal'),template);
   expect(configurationSnapshot(recipient).values[key]).toBe(enabled);
   expect(exportConfigurations(state).configurations[0]!.values[key]).toBe(enabled);
  }
 });
 it('rejects non-boolean controls and values at direct write boundaries',()=>{
  for(const invalid of [{...field,type:'string'},{...field,secret:true},{...field,control:'text'},{...field,defaultValue:'true'}])expect(()=>parseConfigurationField(invalid)).toThrow();
  const state=createConfigurationState([field],()=> 'profile');
  expect(()=>applyConfigurationAction(state,{action:'save',revision:0,id:'profile',values:{[key]:'true'}},()=> 'unused')).toThrow();
 });
});
