import { Router, json, type Request, type RequestHandler, type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AgentStorageRequestError, RuntimeStorageError } from "steamharness/runtime-storage";
import { getRequestPrincipal, requireAuthenticatedPrincipal } from "../auth";
import { HttpError, ok } from "../protocol";
import type { Storage } from "../storage";
import type { OwnedRuntimeWorkspace } from "../runtime-storage/repository";
import { readRuntimeWorkspace, readRuntimeId, readRuntimeText, historyKindSchema, openRuntimeSessionSchema, readRuntimeOperation } from "../runtime-storage/validation";

export function createRuntimeStorageRouter(storage: Storage): Router {
  const router = Router();
  router.use("/runtime-storage", requireAuthenticatedPrincipal(), json({ limit: "16mb" }));
  const user = (req: Request): string => {
    const principal = getRequestPrincipal(req);
    if (!principal || !("userId" in principal) || !principal.userId) throw new HttpError(401, 401, "Account login is required for runtime storage.");
    return principal.userId;
  };
  const repository = () => {
    if (!storage.runtimeStorage) throw new RuntimeStorageError("RUNTIME_STORAGE_UNAVAILABLE", "PostgreSQL runtime storage is not configured.");
    return storage.runtimeStorage;
  };
  const authorize = async (req: Request, workspace: Pick<OwnedRuntimeWorkspace, "kind" | "projectId" | "entryId">) => {
    if (workspace.kind !== "project") return;
    const principal = getRequestPrincipal(req)!;
    await storage.requireProjectCapability(workspace.projectId, { userId: user(req), isSystemAdmin: principal.isSystemAdmin }, "read");
    const project = await storage.getProjectSummary(workspace.projectId);
    if (!project.entries.some(entry => entry.entryId === workspace.entryId)) throw new HttpError(404, 404, "The runtime entry is not registered.");
  };
  const run = (handler: (req: Request) => Promise<unknown>): RequestHandler => (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    void handler(req).then(result => res.json(ok(result ?? null)), next);
  };

  router.post("/runtime-storage/workspaces", run(async req => {
    const input = readRuntimeWorkspace(req.body);
    await authorize(req, input);
    return repository().registerWorkspace(user(req), input);
  }));
  router.post("/runtime-storage/workspaces/resolve", run(async req => {
    let input = readRuntimeWorkspace(req.body);
    if (input.kind === "local") {
      let project;
      try { project = await storage.getProjectSummary(input.projectId); }
      catch (error) { if (!(error instanceof HttpError) || error.statusCode !== 404) throw error; }
      if (project) {
        input = { kind: "project", projectId: input.projectId, entryId: input.entryId };
        await authorize(req, input);
      }
    } else await authorize(req, input);
    return repository().registerWorkspace(user(req), input);
  }));
  router.get("/runtime-storage/workspaces/:workspaceId", run(async req => {
    const workspace = await repository().getWorkspace(user(req), readRuntimeId(req.params.workspaceId));
    await authorize(req, workspace);
    return workspace;
  }));
  router.post("/runtime-storage/workspaces/:workspaceId/sessions/open", run(async req => {
    const input = openRuntimeSessionSchema.parse(req.body);
    const workspace = await repository().getWorkspace(user(req), readRuntimeId(req.params.workspaceId));
    await authorize(req, workspace);
    return repository().openSession(user(req), workspace.id, input.sessionKey, input.ownerToken);
  }));
  const ownedWorkspace = async (req: Request) => {
    const workspace = await repository().getWorkspace(user(req), readRuntimeId(req.params.workspaceId));
    await authorize(req, workspace);
    return workspace;
  };
  router.get("/runtime-storage/workspaces/:workspaceId/history/:kind", run(async req => {
    const workspace = await ownedWorkspace(req);
    return repository().history(user(req), workspace.id, historyKindSchema.parse(req.params.kind));
  }));
  router.get("/runtime-storage/workspaces/:workspaceId/agent-sessions", run(async req => {
    const workspace = await ownedWorkspace(req);
    return repository().agentSessions(user(req), workspace.id, readRuntimeText(req.query.prefix));
  }));
  router.get("/runtime-storage/workspaces/:workspaceId/snapshot", run(async req => {
    const workspace = await ownedWorkspace(req);
    return repository().snapshot(user(req), workspace.id, readRuntimeText(req.query.sessionKey));
  }));
  router.post("/runtime-storage/sessions/:sessionId/operations", run(async req => {
    const sessionId = readRuntimeId(req.params.sessionId);
    const input = readRuntimeOperation(req.body);
    const workspace = await repository().sessionWorkspace(user(req), sessionId);
    await authorize(req, workspace);
    return repository().operation(user(req), sessionId, input, input.operation);
  }));
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (error instanceof HttpError) { next(error); return; }
    let code = "RUNTIME_STORAGE_INVALID_REQUEST", status = 400, message = "Runtime storage request is invalid.";
    if (error instanceof RuntimeStorageError) {
      code = error.code; message = error.message;
      status = code === "RUNTIME_STORAGE_NOT_FOUND" ? 404 : code === "RUNTIME_STORAGE_ACCESS_DENIED" ? 403 : code === "RUNTIME_STORAGE_INVALID_REQUEST" ? 400 : code === "RUNTIME_STORAGE_UNAVAILABLE" ? 503 : 409;
    } else if (error instanceof ZodError || error instanceof SyntaxError) {
      // Never echo submitted records, authentication material, or validation input.
    } else if (error instanceof AgentStorageRequestError) message = error.message;
    else if (error instanceof Error && !("code" in error)) message = error.message;
    else if ((error as { code?: string })?.code === "23505") message = "The storage record or submission request ID already exists.";
    else { code = "RUNTIME_STORAGE_UNAVAILABLE"; status = 503; message = "Runtime storage is temporarily unavailable."; }
    next(new HttpError(status, status, message, { code }));
  };
  router.use("/runtime-storage", handleError);
  return router;
}
