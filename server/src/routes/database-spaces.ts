import { executeDatabaseOperation } from "steamharness";
import { isDatabasePermissionSubset } from "@steamharness/database-spaces";
import { Router, json, type Request } from 'express';
import { requireAuthenticatedPrincipal } from '../auth';
import { requestActor } from './groups';
import { HttpError, ok, toHttpErrorWithStatus } from '../protocol';
import type { Storage } from '../storage';
export function createDatabaseSpaceRouter(storage: Storage): Router {
  const router = Router(); router.use('/database-spaces', requireAuthenticatedPrincipal(), json({ limit: '70mb' }));
  const actor = (req: Request) => { const actor = requestActor(req); return { ...actor, userId: actor.userId ?? (actor.isSystemAdmin ? 'system-admin' : '') }; };
  const run = (handler: (req: Request) => Promise<unknown>) => (req: Request, res: any, next: any) => { void handler(req).then(value => res.json(ok(value)), error => next(toHttpErrorWithStatus(error, 400, 400, 'Database operation failed.'))); };
  const consumer = async (req: Request, projectId: string, entryId: string, write = false) => {
    await storage.requireProjectCapability(projectId, requestActor(req), write ? 'writeData' : 'read');
    const project = await storage.getProjectSummary(projectId);
    const entry = project.entries.find(entry => entry.entryId === entryId);
    if (!entry) throw new HttpError(404,404,'The consumer entry is not registered.');
    return entry;
  };
  router.get('/database-spaces',run(req=>req.query.section?storage.databases.page(actor(req),{section:String(req.query.section),page:Number(req.query.page),pageSize:Number(req.query.pageSize),search:String(req.query.search??''),projectId:typeof req.query.projectId==='string'?req.query.projectId:undefined,entryId:typeof req.query.entryId==='string'?req.query.entryId:undefined}):storage.databases.read(actor(req))));
  router.post('/database-spaces/requests', run(async req => { const entry = await consumer(req,req.body.projectId,req.body.entryId,true); const requirement=entry.databases.find(item=>item.host==='server'&&item.alias===req.body.alias); if(!requirement || !isDatabasePermissionSubset(req.body.permissions,requirement.permissions)) throw new HttpError(400,400,'The request exceeds the declared database requirement.'); return storage.databases.request(req.body,actor(req)); }));
  router.post('/database-spaces/requests/:requestId/review', run(req => {
    if (typeof req.body.approve !== 'boolean') throw new HttpError(400, 400, 'Explicit approval or rejection is required.');
    return storage.databases.review(req.params.requestId!, req.body, actor(req));
  }));
  router.post('/database-spaces/grants/:grantId/:action', run(req => {
    if (!['revoke', 'rotate', 'narrow'].includes(req.params.action!)) throw new HttpError(404, 404, 'Unknown database grant action.');
    return storage.databases.manage(req.params.grantId!, req.params.action as 'revoke' | 'rotate' | 'narrow', actor(req), req.body.permissions);
  }));
  router.get('/database-spaces/bindings/:bindingRef', run(async req => { const projectId = String(req.query.projectId ?? ''), entryId = String(req.query.entryId ?? ''); await consumer(req, projectId, entryId); return storage.databases.authorization(req.params.bindingRef!, { projectId, entryId }); }));
  router.post('/database-spaces/:spaceId/data', run(async req => { const operation = req.body.operation; const write = !['get', 'revision', 'list'].includes(operation) && !(operation === 'transaction' && Array.isArray(req.body.entries) && req.body.entries.every((item: any) => !item.mutation)); const entry = await consumer(req,req.body.projectId,req.body.entryId,write); const requirement=entry.databases.find(item=>item.host==='server'&&item.alias===req.body.alias); if(!requirement) throw new HttpError(403,403,'Database alias is not declared.'); return storage.databases.data(req.params.spaceId!,req.body,actor(req),false,requirement); }));
  router.post('/database-spaces/bindings/:bindingRef/bind',run(req=>storage.bindEntryDatabase(req.body.projectId,req.body.entryId,req.body.alias,req.params.bindingRef!,requestActor(req))));
  router.get('/database-spaces/:spaceId/values',run(req=>storage.databases.listValues(req.params.spaceId!,actor(req),Number(req.query.page)||1,Number(req.query.pageSize)||30,String(req.query.search??''))));
  router.post('/database-spaces/:spaceId/manage',run(async req=>executeDatabaseOperation(await storage.databases.managementDatabase(req.params.spaceId!,actor(req),req.body.input?.namespace),String(req.body.operation),req.body.input??{})));
  router.get('/database-spaces/consumers/:projectId/:entryId',run(async req=>{
    const entry=await consumer(req,req.params.projectId!,req.params.entryId!);
    return Promise.all(entry.databases.map(async requirement=>{
      if(requirement.host!=="server") return {...requirement,status:"local"};
      const bindingRef=await storage.databases.bindingFor({projectId:req.params.projectId!,entryId:req.params.entryId!,alias:requirement.alias})??requirement.bindingRef;
      if(!bindingRef) return {...requirement,status:"unbound"};
      try {const authorization=await storage.databases.authorization(bindingRef,{projectId:req.params.projectId!,entryId:req.params.entryId!});return {...requirement,bindingRef,status:"bound",space:authorization.space};}
      catch(error){return {...requirement,bindingRef,status:"invalid",error:error instanceof Error?error.message:String(error)};}
    }));
  }));
  return router;
}
