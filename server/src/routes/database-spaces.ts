import { executeDatabaseOperation } from "steamharness";
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
  router.get('/database-spaces',run(async req => {
    if (!req.query.section) return storage.databases.read(actor(req));
    const section = String(req.query.section), projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const entryId = typeof req.query.entryId === 'string' ? req.query.entryId : undefined;
    let databaseIds: string[] | undefined;
    if (section === 'spaces' && (projectId || entryId)) {
      if (!projectId) throw new HttpError(400, 400, 'The consumer entry is not registered.');
      await storage.requireProjectCapability(projectId, requestActor(req), 'read');
      const project = await storage.getProjectSummary(projectId);
      const entries = entryId ? project.entries.filter(entry => entry.entryId === entryId) : project.entries;
      if (!entries.length && entryId) throw new HttpError(404, 404, 'The consumer entry is not registered.');
      databaseIds = [...new Set(entries.flatMap(entry => entry.databases.map(database => database.databaseId)))];
    }
    return storage.databases.page(actor(req), { section, page: Number(req.query.page), pageSize: Number(req.query.pageSize), search: String(req.query.search ?? ''), projectId, entryId, databaseIds });
  }));
  router.post('/database-spaces/requests', run(async req => { await consumer(req,req.body.projectId,req.body.entryId,true); return storage.databases.request(req.body,actor(req)); }));
  router.post('/database-spaces/requests/:requestId/review', run(req => {
    if (typeof req.body.approve !== 'boolean') throw new HttpError(400, 400, 'Explicit approval or rejection is required.');
    return storage.databases.review(req.params.requestId!, req.body, actor(req));
  }));
  router.post('/database-spaces/grants/:grantId/:action', run(req => {
    if (!['revoke', 'rotate', 'narrow'].includes(req.params.action!)) throw new HttpError(404, 404, 'Unknown database grant action.');
    return storage.databases.manage(req.params.grantId!, req.params.action as 'revoke' | 'rotate' | 'narrow', actor(req), req.body.permissions);
  }));
  router.get('/database-spaces/:spaceId/authorization', run(async req => { const projectId = String(req.query.projectId ?? ''), entryId = String(req.query.entryId ?? ''); await consumer(req, projectId, entryId); return storage.databases.authorization(req.params.spaceId!, { projectId, entryId }); }));
  router.post('/database-spaces/:spaceId/data', run(async req => { const operation = req.body.operation; const write = !['get', 'revision', 'list'].includes(operation) && !(operation === 'transaction' && Array.isArray(req.body.entries) && req.body.entries.every((item: any) => !item.mutation)); await consumer(req,req.body.projectId,req.body.entryId,write); return storage.databases.data(req.params.spaceId!,req.body,actor(req)); }));
  router.get('/database-spaces/:spaceId/values',run(req=>storage.databases.listValues(req.params.spaceId!,actor(req),Number(req.query.page)||1,Number(req.query.pageSize)||30,String(req.query.search??''))));
  router.post('/database-spaces/:spaceId/manage',run(async req=>executeDatabaseOperation(await storage.databases.managementDatabase(req.params.spaceId!,actor(req),req.body.input?.namespace),String(req.body.operation),req.body.input??{})));
  router.get('/database-spaces/consumers/:projectId/:entryId',run(async req=>{
    const entry=await consumer(req,req.params.projectId!,req.params.entryId!);
    return Promise.all(entry.databases.map(async requirement=>{
      try {const authorization=await storage.databases.authorization(requirement.databaseId,{projectId:req.params.projectId!,entryId:req.params.entryId!});return {...requirement,status:"bound",space:authorization.space};}
      catch(error){return {...requirement,status:"invalid",error:error instanceof Error?error.message:String(error)};}
    }));
  }));
  return router;
}
