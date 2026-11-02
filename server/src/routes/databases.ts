import { Router, json, type Request, type RequestHandler, type ErrorRequestHandler } from "express";
import { z, ZodError } from "zod";
import { DatabaseResourceError } from "steamharness/database";
import { getRequestPrincipal, requireAuthenticatedPrincipal } from "../auth";
import { HttpError, ok } from "../protocol";
import type { Storage } from "../storage";

const id = z.string().uuid().transform(value => value.toLowerCase());
const model = z.string().min(1).max(1024 * 1024);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const migration = z.object({ name: z.string().max(100), sql: z.string().max(4 * 1024 * 1024),
  checksum: fingerprint, schema: model, schemaHash: fingerprint }).strict();
const migrations = z.array(migration).max(1000);

export function createDatabaseRouter(storage: Storage): Router {
  const router = Router();
  router.use("/databases", requireAuthenticatedPrincipal(), json({ limit: "16mb" }));
  const account = (req: Request): string => {
    const principal = getRequestPrincipal(req);
    if (!principal || !("userId" in principal) || !principal.userId) throw new HttpError(401, 401, "Account login is required for database resources.");
    return principal.userId;
  };
  const repository = () => {
    if (!storage.relationalDatabases) throw new DatabaseResourceError("DATABASE_UNAVAILABLE", "Relational database administration is not configured.");
    return storage.relationalDatabases;
  };
  const run = (work: (req: Request) => Promise<unknown>): RequestHandler => (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    void work(req).then(result => res.json(ok(result ?? null)), next);
  };
  const resourceId = (req: Request) => id.parse(req.params.databaseId);
  router.get("/databases", run(async req => ({ items: await repository().list(account(req)) })));
  router.post("/databases", run(req => {
    const actor = account(req), input = z.object({ name: z.string().min(1).max(128), requestId: id }).strict().parse(req.body);
    return repository().create(actor, input);
  }));
  router.get("/databases/:databaseId", run(req => repository().get(account(req), resourceId(req))));
  router.post("/databases/:databaseId/retry", run(req => { z.object({}).strict().parse(req.body ?? {}); return repository().retry(account(req), resourceId(req)); }));
  router.get("/databases/:databaseId/grants", run(req => repository().grants(account(req), resourceId(req))));
  router.post("/databases/:databaseId/grants", run(req => {
    const input = z.object({ userId: z.string().min(1).max(256), mode: z.enum(["read", "write"]) }).strict().parse(req.body);
    return repository().grant(account(req), resourceId(req), input.userId, input.mode);
  }));
  router.delete("/databases/:databaseId/grants/:userId", run(req => repository().revoke(account(req), resourceId(req), z.string().min(1).max(256).parse(req.params.userId))));
  router.get("/databases/:databaseId/migrations", run(req => repository().history(account(req), resourceId(req))));
  router.post("/databases/:databaseId/migrations/plan", run(req => {
    const input = z.object({ schema: model, migrations }).strict().parse(req.body);
    return repository().plan(account(req), resourceId(req), input);
  }));
  router.post("/databases/:databaseId/migrations/deploy", run(req => {
    const input = z.object({ migrations, schemaHash: fingerprint, acceptDataLoss: z.boolean().optional() }).strict().parse(req.body);
    return repository().deploy(account(req), resourceId(req), input);
  }));
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, _res, next) => {
    if (error instanceof HttpError) { next(error); return; }
    if (error instanceof DatabaseResourceError) {
      const status = error.code === "DATABASE_NOT_FOUND" ? 404 : error.code === "DATABASE_ACCESS_DENIED" ? 403
        : error.code === "DATABASE_INVALID_REQUEST" || error.code === "DATABASE_SCHEMA_INVALID" ? 400
        : error.code === "DATABASE_UNAVAILABLE" ? 503 : 409;
      next(new HttpError(status, status, error.message, { code: error.code })); return;
    }
    const invalid = error instanceof ZodError || error instanceof SyntaxError;
    next(new HttpError(invalid ? 400 : 503, invalid ? 400 : 503,
      invalid ? "Invalid database management request." : "Database administration is temporarily unavailable.",
      { code: invalid ? "DATABASE_INVALID_REQUEST" : "DATABASE_UNAVAILABLE" }));
  };
  router.use("/databases", errorHandler);
  return router;
}
