import { Router, json, type Request } from "express";
import {
  isProjectRole,
  type AccessActor,
  type ResourceType,
} from "@steamharness/project-access";
import { getRequestPrincipal, requireAuthenticatedPrincipal } from "../auth";
import { recordAuditEventForRequest, createAuditActor } from "../audit";
import { HttpError, ok } from "../protocol";
import { type PageQuery } from "../project-access";
import type { Storage } from "../storage";

export function requestActor(req: Request): AccessActor {
  const principal = getRequestPrincipal(req);
  if (!principal) throw new HttpError(401, 401, "Unauthorized.");
  return {
    userId: "userId" in principal ? principal.userId : undefined,
    isSystemAdmin: principal.isSystemAdmin,
  };
}
export function pageQuery(req: Request): PageQuery {
  const query: PageQuery = {
    page: req.query.page === undefined ? 1 : Number(req.query.page),
    pageSize:
      req.query.pageSize === undefined ? 20 : Number(req.query.pageSize),
    q: typeof req.query.q === "string" ? req.query.q : "",
  };
  for (const key of ["parentId", "groupId"] as const)
    if (req.query[key] !== undefined) {
      if (typeof req.query[key] !== "string")
        throw new HttpError(400, 400, "Invalid group filter.");
      query[key] = req.query[key] || null;
    }
  if (req.query.minRole !== undefined) {
    if (!isProjectRole(req.query.minRole))
      throw new HttpError(400, 400, "Invalid role filter.");
    query.minRole = req.query.minRole;
  }
  if (req.query.status !== undefined) {
    if (!["all", "published", "draft"].includes(String(req.query.status)))
      throw new HttpError(400, 400, "Invalid project status.");
    query.status = String(req.query.status);
  }
  return query;
}
export function createGroupRouter(storage: Storage): Router {
  const router = Router();
  const parseBody = json({ limit: "10mb" });
  router.use(
    [
      "/groups",
      "/projects/:id/members",
      "/projects/:id/invitations",
      "/projects/:id/group",
    ],
    requireAuthenticatedPrincipal(),
  );
  const run =
    (handler: (req: Request) => Promise<unknown>) =>
    (req: Request, res: any, next: any) => {
      void handler(req)
        .then((data) => res.json(ok(data)))
        .catch(next);
    };
  const audit = async (req: Request, eventType: string, id: string) => {
    await recordAuditEventForRequest(req, {
      ...createAuditActor(getRequestPrincipal(req)),
      eventType,
      outcome: "success",
      resourceType: eventType.startsWith("project.") ? "project" : "group",
      resourceId: id,
    });
  };
  router.get(
    "/groups",
    run((req) =>
      storage.accessRepository.listGroups(requestActor(req), pageQuery(req)),
    ),
  );
  router.post(
    "/groups",
    parseBody,
    run(async (req) => {
      if (
        typeof req.body?.name !== "string" ||
        (req.body.description !== undefined &&
          typeof req.body.description !== "string") ||
        (req.body.parentId != null && typeof req.body.parentId !== "string")
      )
        throw new HttpError(400, 400, "Group fields are invalid.");
      const group = await storage.accessRepository.createGroup(
        req.body,
        requestActor(req),
      );
      await audit(req, "group.create", group.id);
      return group;
    }),
  );
  router.get(
    "/groups/:id",
    run((req) =>
      storage.accessRepository.getGroup(req.params.id, requestActor(req)),
    ),
  );
  router.patch(
    "/groups/:id",
    parseBody,
    run(async (req) => {
      if (
        (req.body.name !== undefined && typeof req.body.name !== "string") ||
        (req.body.description !== undefined &&
          typeof req.body.description !== "string") ||
        (req.body.parentId != null && typeof req.body.parentId !== "string")
      )
        throw new HttpError(400, 400, "Group fields are invalid.");
      const group = await storage.accessRepository.updateGroup(
        req.params.id,
        req.body,
        requestActor(req),
      );
      await audit(req, "group.update", group.id);
      return group;
    }),
  );
  router.delete(
    "/groups/:id",
    run(async (req) => {
      await storage.accessRepository.deleteGroup(
        req.params.id,
        requestActor(req),
      );
      await audit(req, "group.delete", req.params.id);
      return { deleted: true };
    }),
  );
  for (const [type, prefix] of [
    ["group", "/groups/:id"],
    ["project", "/projects/:id"],
  ] as const) {
    router.get(
      `${prefix}/members`,
      run((req) =>
        storage.accessRepository.listMembers(
          type,
          req.params.id,
          requestActor(req),
          pageQuery(req),
        ),
      ),
    );
    router.put(
      `${prefix}/members/:userId`,
      parseBody,
      run(async (req) => {
        if (!isProjectRole(req.body?.role))
          throw new HttpError(400, 400, "Invalid role.");
        await storage.accessRepository.setMember(
          type,
          req.params.id,
          req.params.userId,
          req.body.role,
          requestActor(req),
        );
        await audit(req, `${type}.member.update`, req.params.id);
        return { userId: req.params.userId, role: req.body.role };
      }),
    );
    router.delete(
      `${prefix}/members/:userId`,
      run(async (req) => {
        await storage.accessRepository.setMember(
          type,
          req.params.id,
          req.params.userId,
          undefined,
          requestActor(req),
        );
        await audit(req, `${type}.member.remove`, req.params.id);
        return { removed: true };
      }),
    );
    router.get(
      `${prefix}/invitations`,
      run((req) =>
        storage.accessRepository.listInvitations(
          type,
          req.params.id,
          requestActor(req),
        ),
      ),
    );
    router.post(
      `${prefix}/invitations`,
      parseBody,
      run(async (req) => {
        if (!isProjectRole(req.body?.role))
          throw new HttpError(400, 400, "Invalid role.");
        const invitation = await storage.accessRepository.createInvitation(
          type,
          req.params.id,
          req.body.role,
          requestActor(req),
        );
        await audit(req, `${type}.invitation.create`, req.params.id);
        return { invitation, token: invitation.token };
      }),
    );
    router.delete(
      `${prefix}/invitations/:invitationId`,
      run(async (req) => ({
        revoked: await storage.accessRepository.revokeInvitation(
          type,
          req.params.id,
          req.params.invitationId,
          requestActor(req),
        ),
      })),
    );
  }
  router.put(
    "/projects/:id/group",
    parseBody,
    run(async (req) => {
      if (req.body.groupId !== null && typeof req.body.groupId !== "string")
        throw new HttpError(400, 400, "groupId must be a group ID or null.");
      await storage.accessRepository.transferProject(
        req.params.id,
        req.body.groupId,
        requestActor(req),
      );
      await audit(req, "project.transfer", req.params.id);
      return { groupId: req.body.groupId };
    }),
  );
  return router;
}
