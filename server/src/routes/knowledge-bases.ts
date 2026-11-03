import { Router, json, type Request, type RequestHandler, type ErrorRequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { getRequestPrincipal, requireAuthenticatedPrincipal } from '../auth';
import { HttpError, ok } from '../protocol';
import type { Storage } from '../storage';

const id = z.string().uuid().transform(value => value.toLowerCase());
const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const identity = z.object({ projectId: id, entryId: alias, alias, knowledgeBaseId: id }).strict();
const binding = z.object({ id, revision: z.number().int().positive(), knowledgeBaseId: id, mode: z.enum(['read', 'write']), accessRevision: z.number().int().nonnegative() }).strict();
export function createKnowledgeBaseRouter(storage: Storage): Router {
  const router = Router(); router.use('/knowledge-bases', requireAuthenticatedPrincipal(), json({ limit: '70mb' }));
  const account = (req: Request): string => {
    const principal = getRequestPrincipal(req);
    if (!principal || !('userId' in principal) || !principal.userId) throw new HttpError(401, 401, 'Account login is required for knowledge bases.');
    return principal.userId;
  };
  const consumer = async (req: Request, input: z.infer<typeof identity>, write = false) => {
    let project;
    try { project = await storage.getProjectSummary(input.projectId); }
    catch (error) { if (!(error instanceof HttpError) || error.statusCode !== 404) throw error; }
    if (project) {
      await storage.requireProjectCapability(input.projectId, { userId: account(req), isSystemAdmin: getRequestPrincipal(req)!.isSystemAdmin }, write ? 'writeData' : 'read');
      const requirements = await storage.entryKnowledgeBaseRequirements(input.projectId, input.entryId);
      if (!requirements.some(base => base.alias === input.alias && base.knowledgeBaseId === input.knowledgeBaseId)) throw new HttpError(403, 403, 'This knowledge base is not declared for the registered entry.');
    }
  };
  const run = (work: (req: Request) => Promise<unknown>): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); void work(req).then(value => res.json(ok(value ?? null)), next);
  };
  const repository = storage.knowledgeBases;
  router.get('/knowledge-bases', run(req => repository.list(account(req), { page: req.query.page === undefined ? undefined : Number(req.query.page), pageSize: req.query.pageSize === undefined ? undefined : Number(req.query.pageSize), search: String(req.query.search ?? '') })));
  router.post('/knowledge-bases', run(req => repository.create(account(req), z.object({ name: z.string().min(1).max(128), requestId: id }).strict().parse(req.body))));
  router.get('/knowledge-bases/bindings', run(req => { const input = z.object({ projectId: id, entryId: alias }).strict().parse(req.query); return repository.bindings(account(req), input.projectId, input.entryId); }));
  router.delete('/knowledge-bases/bindings', run(req => { const input = z.object({ projectId: id, entryId: alias, alias }).strict().parse(req.body); return repository.unbind(account(req), input.projectId, input.entryId, input.alias); }));
  router.post('/knowledge-bases/bindings', run(async req => {
    const input = identity.extend({ mode: z.enum(['read', 'write']).optional() }).strict().parse(req.body); await consumer(req, identity.parse({ projectId: input.projectId, entryId: input.entryId, alias: input.alias, knowledgeBaseId: input.knowledgeBaseId }), true);
    return repository.bind(account(req), input);
  }));
  router.post('/knowledge-bases/bindings/resolve', run(async req => { const input = identity.parse(req.body); await consumer(req, input); return repository.resolveBinding(account(req), input); }));
  router.get('/knowledge-bases/:baseId', run(req => repository.describe(account(req), id.parse(req.params.baseId))));
  router.get('/knowledge-bases/:baseId/grants', run(req => repository.grants(account(req), id.parse(req.params.baseId))));
  router.post('/knowledge-bases/:baseId/grants', run(req => { const input = z.object({ userId: z.string().min(1).max(256), mode: z.enum(['read', 'write']) }).strict().parse(req.body); return repository.grant(account(req), id.parse(req.params.baseId), input.userId, input.mode); }));
  router.delete('/knowledge-bases/:baseId/grants/:userId', run(req => repository.grant(account(req), id.parse(req.params.baseId), z.string().min(1).max(256).parse(req.params.userId), 'read', true)));
  router.post('/knowledge-bases/:baseId/operations', run(async req => {
    const input = identity.extend({ binding, operation: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()) }).strict().parse(req.body);
    const consumerIdentity = identity.parse({ projectId: input.projectId, entryId: input.entryId, alias: input.alias, knowledgeBaseId: input.knowledgeBaseId });
    await consumer(req, consumerIdentity, /\.(?:create|edit|delete)/.test(input.operation));
    return repository.operation(account(req), id.parse(req.params.baseId), input.operation, input.input, { identity: consumerIdentity, binding: input.binding });
  }));
  router.post('/knowledge-bases/:baseId/manage', run(req => { const input = z.object({ operation: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()) }).strict().parse(req.body); return repository.operation(account(req), id.parse(req.params.baseId), input.operation, input.input); }));
  const errors: ErrorRequestHandler = (error, _req, _res, next) => {
    if (error instanceof HttpError) { next(error); return; }
    const invalid = error instanceof ZodError || error instanceof SyntaxError;
    next(new HttpError(invalid ? 400 : 503, invalid ? 400 : 503, invalid ? 'Invalid knowledge request.' : 'Knowledge storage is temporarily unavailable.'));
  };
  router.use('/knowledge-bases', errors); return router;
}
