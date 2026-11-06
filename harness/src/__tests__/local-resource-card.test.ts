import test from 'node:test';
import assert from 'node:assert/strict';
import { runPresentationCardAction } from '../agent/capabilities/presentation-card';
import type { NodeContext } from '../types/context';
test('local knowledge card readers preserve arguments and require a local knowledge target',async()=>{
  const context={projectId:'11111111-1111-4111-8111-111111111111',entryId:'agent'} as NodeContext;
  const args={action:'upsert' as const,cardId:'knowledge',kind:'knowledge' as const,target:{source:'current',entryId:'database'},reader:{entrypointId:'read',args:['--id','one']}};
  const result=await runPresentationCardAction(context,args) as any;
  assert.deepEqual(result.reader,args.reader);assert.equal(result.target.projectId,context.projectId);
  await assert.rejects(runPresentationCardAction(context,{...args,target:{source:'server',projectId:context.projectId!,entryId:'database'}}),/local Workflow/);
  await assert.rejects(runPresentationCardAction(context,{...args,kind:'project'}),/local Workflow/);
  await assert.rejects(runPresentationCardAction(context,{...args,reader:{entrypointId:'../escape'}}),/local Workflow/);
  await assert.rejects(runPresentationCardAction(context,{...args,action:'remove'}),/only its card id/);
});
