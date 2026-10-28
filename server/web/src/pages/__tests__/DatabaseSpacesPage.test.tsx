import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { i18n } from '@steamharness/i18n/react';
import { apiClient } from '../../api';
import { DatabaseSpacesPage } from '../DatabaseSpacesPage';
import { parseRoute, routeToPath } from '../../utils/routes';
import { createServerKnowledgeRepository } from '../detail/knowledge-repository';
const spaceId='adbe104c-5528-4db6-817d-bb567996876f', fileId='830db069-3975-46dd-b47f-f4433bc37990';
const ok=(data:unknown):any=>({errCode:0,errMessage:'',data});
beforeEach(async()=>{
 await i18n.changeLanguage('en');
 vi.spyOn(apiClient,'databasePage').mockResolvedValue(ok({items:[],total:0,page:1,pageSize:20}));
 vi.spyOn(apiClient,'databaseValues').mockResolvedValue(ok({items:[{key:'one',namespace:'space',value:{count:1}},{key:'two',namespace:'conversation:owner',value:2}],total:2,page:1,pageSize:30}));
});
afterEach(()=>vi.restoreAllMocks());
it('keeps database resources independent of project routes and round trips entry configuration URLs',()=>{
 const path='/detail/project/entries/agent/configurations';expect(routeToPath(parseRoute(path))).toBe(path);
 expect(parseRoute('/databases/'+spaceId)).toEqual({page:'databases',id:spaceId});
 expect(parseRoute('/detail/project/dependencies')).toEqual({page:'detail',id:'project',tab:'project'});
});
it('preserves a failed KV draft and sends the selected space and conversation namespace',async()=>{
 const operation=vi.spyOn(apiClient,'databaseOperation').mockResolvedValueOnce({errCode:403,errMessage:'Grant revoked'}).mockResolvedValue(ok(null));
 render(<DatabaseSpacesPage spaceId={spaceId}/>);
 fireEvent.click(await screen.findByRole('button',{name:'two'}));
 fireEvent.change(screen.getByLabelText('JSON value'),{target:{value:'3'}});
 fireEvent.click(screen.getByRole('button',{name:'Save'}));
 expect(await screen.findByText('Grant revoked')).toBeTruthy();
 expect(screen.getByLabelText('JSON value')).toHaveValue('3');
 expect(operation).toHaveBeenCalledWith(spaceId,'kv.setValue',{key:'two',namespace:'conversation:owner',scope:'conversation',value:3});
 fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(operation).toHaveBeenCalledTimes(2));
});
it('confirms discarding a draft before choosing a different key or leaving the space',async()=>{
 const onBack=vi.fn();render(<DatabaseSpacesPage spaceId={spaceId} onBack={onBack}/>);
 fireEvent.click(await screen.findByRole('button',{name:'one'}));
 fireEvent.change(screen.getByLabelText('JSON value'),{target:{value:'42'}});
 fireEvent.click(screen.getByRole('button',{name:'two'}));
 expect(await screen.findByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(screen.getByLabelText('Key')).toHaveValue('one');
 fireEvent.click(screen.getByRole('button',{name:'Back to spaces'}));
 expect(onBack).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
 await waitFor(()=>expect(onBack).toHaveBeenCalledOnce());
});
it('disables repeated data mutations until the current operation finishes',async()=>{
 let finish!:(value:any)=>void;const operation=vi.spyOn(apiClient,'databaseOperation').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 render(<DatabaseSpacesPage spaceId={spaceId}/>);fireEvent.click(await screen.findByRole('button',{name:'one'}));
 const save=screen.getByRole('button',{name:'Save'});fireEvent.click(save);fireEvent.click(save);
 expect(operation).toHaveBeenCalledOnce();expect(save).toBeDisabled();
 await act(async()=>finish(ok(null)));await waitFor(()=>expect(save).toBeEnabled());
});
it('cancels pending knowledge attachment reads when the space changes and revokes late URLs',async()=>{
 let finish!:(blob:Blob)=>void;let signal:AbortSignal|undefined;
 const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:space-image'),revoke=vi.spyOn(URL,'revokeObjectURL');
 vi.spyOn(apiClient,'fetchDatabaseFile').mockImplementation((_space,_file,input)=>{signal=input;return new Promise(resolve=>{finish=resolve;});});
 vi.spyOn(apiClient,'databaseOperation').mockImplementation(async(id,operation)=>ok(id!==spaceId?{items:[],hasMore:false,total:0}:operation==='knowledge.listDocuments'?{items:[{id:'guide',title:'Guide',markdownPreview:'Preview',createdAt:'2026-10-27',updatedAt:'2026-10-27'}],hasMore:false,total:1}:{id:'guide',title:'Guide',markdown:`![Image](database://${spaceId}/files/${fileId})`,createdAt:'2026-10-27',updatedAt:'2026-10-27'}));
 const view=render(<DatabaseSpacesPage spaceId={spaceId}/>);
 fireEvent.mouseDown(screen.getByRole('tab',{name:'Knowledge base'}),{button:0,ctrlKey:false});
 fireEvent.click(await screen.findByRole('button',{name:'Guide'}));await waitFor(()=>expect(signal).toBeDefined());
 view.rerender(<DatabaseSpacesPage spaceId={fileId}/>);await waitFor(()=>expect(signal!.aborted).toBe(true));
 await act(async()=>finish(new Blob(['image'])));await waitFor(()=>expect(create).toHaveBeenCalledOnce());
 expect(revoke).toHaveBeenCalledWith('blob:space-image');
});
it('routes knowledge operations through the shared space identity and preserves cancellation',async()=>{
 const call=vi.spyOn(apiClient,'databaseOperation').mockResolvedValue(ok({id:'guide'}));
 const repository=createServerKnowledgeRepository(apiClient,spaceId),signal=new AbortController().signal;
 await repository.getDocument('guide',{signal});expect(call).toHaveBeenCalledWith(spaceId,'knowledge.getDocument',{documentId:'guide'},signal);
 await repository.updateDocument('guide',{title:'Changed',markdown:'Shared'});expect(call).toHaveBeenLastCalledWith(spaceId,'knowledge.editDocument',{documentId:'guide',title:'Changed',markdown:'Shared'},undefined);
});
