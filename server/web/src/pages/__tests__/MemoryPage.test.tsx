import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n } from '@steamharness/i18n/react';
const { call }=vi.hoisted(()=>({call:vi.fn()}));
vi.mock('@steamharness/account-memory',async original=>({...await original<object>(),createMemoryClient:()=>({call})}));
import { MemoryPage } from '../MemoryPage';
const record={id:'one',scope:'global',content:'Complete private memory',origin:'manual',version:3,updatedAt:'2026-10-01T00:00:00Z',sources:[{id:'user',role:'user',content:'Source excerpt'}]};
beforeEach(async()=>{await i18n.changeLanguage('en');call.mockReset();call.mockImplementation(async action=>action==='capabilities'?{connected:true,enabled:true,status:'ready',automatic:true,readOnly:false}:action==='preferences'?{enabled:true,automatic:true}:action==='list'?{items:[record]}:action==='get'?record:[]);});
test('lists compact records and preserves an edit draft on a version conflict',async()=>{
 render(<MemoryPage/>);fireEvent.click(await screen.findByRole('button',{name:record.content}));fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
 const input=screen.getByRole('textbox',{name:'Memory content'});fireEvent.change(input,{target:{value:'My new decision'}});
 call.mockImplementation(async action=>{if(action==='update')throw Object.assign(new Error('Conflict'),{status:409});return [];});
 fireEvent.click(screen.getByRole('button',{name:'Save'}));await screen.findByText(/This memory changed/);expect(input).toHaveValue('My new decision');
 expect(call.mock.calls.find(args=>args[0]==='update')?.[1]).toMatchObject({id:'one',version:3,content:'My new decision'});
});
test('details revalidate access and discard an earlier selection response',async()=>{
 let finish!:(value:unknown)=>void;
 call.mockImplementation(async action=>action==='get'?new Promise(resolve=>finish=resolve):action==='capabilities'?{status:'ready',connected:true,enabled:true}:action==='preferences'?{enabled:true,automatic:true}:action==='list'?{items:[record]}:[]);
 render(<MemoryPage/>);fireEvent.click(await screen.findByRole('button',{name:record.content}));
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'different search'}});
 await waitFor(()=>expect(call.mock.calls.some(args=>args[0]==='list'&&args[1]?.query==='different search')).toBe(true));
 finish({...record,content:'STALE PRIVATE DETAIL'});await Promise.resolve();
 expect(screen.queryByText('STALE PRIVATE DETAIL')).toBeNull();
 call.mockImplementation(async action=>{if(action==='get')throw Object.assign(new Error('Locked'),{status:403});return [];});
 fireEvent.click(screen.getByRole('button',{name:record.content}));await screen.findByText(/Permission locked/);
 expect(screen.queryByRole('button',{name:'Edit'})).toBeNull();
});
test('unconfigured and failed service states do not masquerade as an empty list',async()=>{
 call.mockImplementation(async action=>action==='capabilities'?{connected:false,enabled:true,status:'unconfigured'}:action==='preferences'?{enabled:true,automatic:false}:[]);
 render(<MemoryPage/>);await screen.findByText(/not configured on this server/);expect(screen.queryByText(/sign in again/i)).toBeNull();expect(screen.queryByText('No memories yet')).toBeNull();expect(screen.getByRole('button',{name:'Remember'})).toBeDisabled();
});
test('stale responses after an account panel unmount never repopulate the new panel',async()=>{
 let finish!:(value:unknown)=>void;call.mockImplementation(async action=>action==='list'?new Promise(resolve=>finish=resolve):action==='capabilities'?{status:'ready',connected:true,enabled:true}:action==='preferences'?{enabled:true,automatic:true}:[]);
 const previous=render(<MemoryPage/>);await waitFor(()=>expect(finish).toBeTypeOf('function'));previous.unmount();
 call.mockImplementation(async action=>action==='list'?{items:[]}:action==='capabilities'?{status:'ready',connected:true,enabled:true}:action==='preferences'?{enabled:true,automatic:true}:[]);
 render(<MemoryPage/>);await screen.findByText('No memories yet');finish({items:[record]});await Promise.resolve();expect(screen.queryByText(record.content)).toBeNull();
});
test('Chinese controls and empty state use the current UI language',async()=>{
 await i18n.changeLanguage('zh-CN');call.mockImplementation(async action=>action==='list'?{items:[]}:action==='capabilities'?{status:'ready',connected:true,enabled:true}:action==='preferences'?{enabled:true,automatic:true}:[]);
 render(<MemoryPage/>);await screen.findByText('暂无记忆');expect(screen.getByRole('button',{name:'记住'})).toBeEnabled();
});
