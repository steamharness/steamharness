import { describe, it, expect, vi } from 'vitest';
import { readLocalWorkflowResource } from '../web/local-resource-reader';
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
});
