import { resolveResourceAccess } from '@steamharness/project-access';
import { createConfigurationState } from '@steamharness/project-configuration';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { i18n } from '@steamharness/i18n/react';
import { apiClient } from '../../api';
import { DetailPage, getDetailNavItems } from '../DetailPage';
import type { DetailPageProps } from '../detail/types';
import type { Summary } from '../../types';

const entries = (['conversation','workflow','kanban'] as const).map((type,index) => ({entryId:`entry-${index}`,type,name:`Window ${index}`,root:`entry-${index}`,entry:type==='kanban'?'index.html':'index.ts',databases:[]}));
const project: Summary = {id:'demo',name:'Aggregate',projectCard:{icon:"workflow",iconBackgroundColor:"#2563eb"},projectInfo:{localizedNames:{},declarations:[],platformSupport:{mode:'agnostic'}},entries,defaultEntry:'entry-0',hasDraft:true,latest:'1.0.0',versions:['1.0.0'],nextVersion:'1.0.1',visibility:'private',access:resolveResourceAccess([{type:'project',id:'demo',role:'owner'}])};
const props = (overrides: Partial<DetailPageProps> = {}): DetailPageProps => ({project,detail:{versions:null,members:[],invitations:[]},activeTab:'entries',busy:{},onUpdateVisibility:vi.fn(),onSetProjectMember:vi.fn(),onRemoveProjectMember:vi.fn(),onCreateProjectInvitation:vi.fn(),onRevokeProjectInvitation:vi.fn(),onNavigateTab:vi.fn(),onNavigateProjectTab:vi.fn(),sidebarCollapsed:false,onRefresh:vi.fn(),...overrides});
beforeEach(async()=>{await i18n.changeLanguage('en');});
afterEach(()=>vi.restoreAllMocks());
it('shows registered entry types, paths and default entry in one aggregate',()=>{
 render(<DetailPage {...props()}/>);
 for(const entry of entries){expect(screen.getByText(entry.name)).toBeTruthy();expect(screen.getByText(entry.type)).toBeTruthy();expect(screen.getByText(`${entry.root}/${entry.entry}`)).toBeTruthy();}
 expect(screen.getByText(/Default entry: entry-0/)).toBeTruthy();
 expect(getDetailNavItems(project).map(item=>item.tab)).toEqual(['project','entries','configurations','databases','settings','versions','members','invitations']);
});
it('keeps project member navigation separate from database management authority',()=>{
 const guest={...project,access:resolveResourceAccess([{type:'project' as const,id:'demo',role:'guest' as const}])};
 expect(getDetailNavItems(guest).map(item=>item.tab)).toContain('members');
 expect(getDetailNavItems(guest).map(item=>item.tab)).not.toContain('invitations');
 expect(getDetailNavItems(guest).map(item=>item.tab)).toContain('databases');
});
it('loads configuration for the selected entry and follows a new entry URL',async()=>{
 const service=vi.spyOn(apiClient,'projectConfigurations').mockResolvedValue({errCode:0,errMessage:'',data:createConfigurationState([],()=> 'default')});
 const onSelectEntry=vi.fn();const view=render(<DetailPage {...props({activeTab:'configurations',entryId:'entry-1',onSelectEntry})}/>);
 await waitFor(()=>expect(service).toHaveBeenCalledWith('demo',{action:'get'},'draft','entry-1'));
 fireEvent.keyDown(screen.getByRole('combobox',{name:'Project entries'}),{key:'ArrowDown'});
 fireEvent.click(await screen.findByRole('option',{name:'Window 2 · kanban'}));
 expect(onSelectEntry).toHaveBeenCalledWith('entry-2');
 await waitFor(()=>expect(service).toHaveBeenCalledWith('demo',{action:'get'},'draft','entry-2'));
 view.rerender(<DetailPage {...props({activeTab:'configurations',entryId:'entry-0'})}/>);
 await waitFor(()=>expect(service).toHaveBeenLastCalledWith('demo',{action:'get'},'draft','entry-0'));
});
it('opens entry database bindings without requesting project-owned data',async()=>{
 const bindings=vi.spyOn(apiClient,'entryDatabaseBindings').mockResolvedValue({errCode:0,errMessage:'',data:[]});
 const catalog=vi.spyOn(apiClient,'databasePage').mockResolvedValue({errCode:0,errMessage:'',data:{items:[],total:0,page:1,pageSize:20}});
 render(<DetailPage {...props({activeTab:'databases'})}/>);
 await waitFor(()=>expect(catalog).toHaveBeenCalledWith('spaces',1,'','demo'));
 expect(bindings).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Requests and permissions'}));
 await waitFor(()=>expect(bindings).toHaveBeenCalledWith('demo','entry-0'));
 expect((await screen.findAllByText('No matching resources.')).length).toBeGreaterThan(0);
});
