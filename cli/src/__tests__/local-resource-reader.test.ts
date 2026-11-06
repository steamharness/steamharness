import { describe, it, expect, vi } from 'vitest';
import { readLocalWorkflowResource } from '../web/local-resource-reader';
import { conversationResourceCards } from '../web/resource-cards';
import type { Project, Runtime } from '../web/workflow-types';
const owner = {id:'project',entryId:'agent',folderPath:'/fixture/project',uri:'file:///fixture/project'} as Project;
const target = {...owner,entryId:'database',projectType:'workflow',entrypoints:[{id:'read',readOnly:true},{id:'write'}]} as Project;
function runtime() { return {inspect:vi.fn(async()=>({projects:[target],errors:[]})),run:vi.fn(async()=>({status:'success',result:{data:{errCode:0,errMessage:'',output:{errCode:0,format:'markdown',content:'# Local'}}}}))} as unknown as Runtime; }
describe('local resource readers',()=>{
  it('rechecks the target and passes cancellation and read-only restriction to execution',async()=>{
    const host=runtime(), abort=new AbortController();
    expect(await readLocalWorkflowResource(host,owner,'database',{entrypointId:'read',args:['--id','one']},abort.signal)).toMatchObject({content:'# Local'});
    expect(host.run).toHaveBeenCalledWith(expect.objectContaining({readOnly:true,abortSignal:abort.signal,project:expect.objectContaining({entryId:'database'})}),expect.any(Function));
    await expect(readLocalWorkflowResource(host,owner,'database',{entrypointId:'write'})).rejects.toThrow('read-only');
    expect(host.run).toHaveBeenCalledTimes(1);
    vi.mocked(host.inspect).mockResolvedValueOnce({projects:[{...target,id:'other'}],errors:[]});
    await expect(readLocalWorkflowResource(host,owner,'database',{entrypointId:'read'})).rejects.toThrow('same project');
    abort.abort();await expect(readLocalWorkflowResource(host,owner,'database',{entrypointId:'read'},abort.signal)).rejects.toThrow();
  });
  it('keeps local knowledge cards without a remote alias and drops server or malformed readers',()=>{
    const card=(reader:unknown,source='current')=>[{metadata:{kind:'agent-part',partType:'tool'},content:{status:'success',tool:'kb_get_document',output:{details:{resourceCard:{kind:'knowledge',target:{source,projectId:'project',entryId:'database'},reader}}}}}];
    expect(conversationResourceCards(card({entrypointId:'read'}) as any,'project','agent','conversation')[0]).toMatchObject({reader:{entrypointId:'read'},target:{source:'local',entryId:'database'}});
    expect(conversationResourceCards(card({entrypointId:'read'},'server') as any,'project','agent','conversation')).toEqual([]);
    expect(conversationResourceCards(card({entrypointId:'../escape'}) as any,'project','agent','conversation')).toEqual([]);
  });
});

it('binds document selection and search query without rewriting the saved reader arguments',async()=>{
 const {selectedKnowledgeReader}=await import('../web/resource-reader-contract');
 const reader={entrypointId:'preview',args:['--payload','{"query":"干员"}']};
 const selected=selectedKnowledgeReader(reader,{documentId:'guide',query:'干员'});
 expect(selected.args).toEqual([...reader.args,'--document-id','guide','--query','干员']);
 expect(reader.args).toEqual(['--payload','{"query":"干员"}']);
 expect(selectedKnowledgeReader(reader,{documentId:'',query:'干员'}).args).toContain('');
});
