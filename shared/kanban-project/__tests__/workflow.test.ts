import {it,expect} from 'vitest';
import {parseKanbanBridgeCall} from '../index';
it('validates local Workflow controls without accepting identity or paths',()=>{
 const parse=(input:unknown)=>parseKanbanBridgeCall({requestId:'bridge',operation:'entries.workflow',input});
 expect(parse({entryId:'capture',action:'start',entrypointId:'listen',requestId:'stable',params:{windowId:'42',recordActions:'true'}}).operation).toBe('entries.workflow');
 expect(()=>parse({entryId:'capture',action:'page',runId:'run',page:0})).toThrow();
 expect(()=>parse({entryId:'capture',action:'list',limit:101})).toThrow();
 expect(()=>parse({entryId:'capture',action:'start',entrypointId:'listen',params:{recordActions:true},requestId:'stable'})).toThrow();
 expect(()=>parse({entryId:'capture',action:'file',runId:'run',fileId:'image',projectId:'another'})).toThrow();
 expect(()=>parse({entryId:'capture',action:'file',runId:'run',fileId:'image',path:'/tmp/private'})).toThrow();
});
it('accepts bounded readonly time ranges and rejects malformed or foreign timeline fields',()=>{
 const parse=(input:Record<string,unknown>)=>parseKanbanBridgeCall({requestId:'bridge',operation:'entries.workflow',input:{entryId:'capture',action:'timeline',runId:'run',...input}});
 expect(parse({from:1000,to:2000,at:1500,limit:24}).input.at).toBe(1500);
 expect(parse({position:100,direction:'next'}).input.position).toBe(100);
 for(const input of [{from:-1},{from:2,to:1},{at:NaN},{limit:49},{limit:1.2},{position:-1},{direction:'next'},{position:1,direction:'wrong'},{path:'/private'},{projectId:'foreign'}])expect(()=>parse(input)).toThrow();
});
