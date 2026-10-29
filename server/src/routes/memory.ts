import express, { Router } from "express";
import { readRequestPrincipal } from "../auth";
import { HttpError, ok } from "../protocol";
import type { AccountMemory } from "../memory";
export function createMemoryRouter(memory?: AccountMemory) {
  const router = Router();
  router.use(express.json({ limit: "256kb" }));
  const routes: [string, string, string][] = [
    ["get", "/memory/capabilities", "capabilities"],
    ["get", "/memory/preferences", "preferences"],
    ["patch", "/memory/preferences", "setPreferences"],
    ["post", "/memory/grants", "grant"],
    ["post", "/memory/revoke", "revoke"],
    ["get", "/memory/scopes", "scopes"],
    ["get", "/memory/jobs", "jobs"],
    ["post", "/memory/jobs/:id/retry", "retry"],
    ["get", "/memories", "list"],
    ["get", "/memories/:id", "get"],
    ["post", "/memories", "remember"],
    ["patch", "/memories/:id", "update"],
    ["delete", "/memories/:id", "forget"],
    ["post", "/memory/recall", "recall"],
    ["post", "/memory/turns", "turn"],
    ["post", "/memory/clear", "clear"],
  ];
  for (const [method, path, action] of routes)
    (router as any)[method](
      path,
      async (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        try {
          res.setHeader("Cache-Control", "no-store");
          if (!memory)
            throw new HttpError(503, 503, "Account memory is not configured.");
          const bearer = /^Bearer\s+(\S+)$/i.exec(
            req.headers.authorization ?? "",
          )?.[1];
          if (!bearer) {
            const origin = req.get("origin");
            let sameOrigin = !origin;
            if (origin) {
              try {
                const parsed = new URL(origin);
                sameOrigin = ["http:", "https:"].includes(parsed.protocol) && parsed.host === req.get("host");
              } catch { /* Invalid origins are rejected, never treated as server failures. */ }
            }
            if (
              req.get("sec-fetch-site") === "cross-site" ||
              !sameOrigin
            )
              throw new HttpError(
                403,
                403,
                "Cross-origin account memory access is not allowed.",
              );
          }
          const identity = await memory.identify(
            bearer,
            bearer?.startsWith("shm")
              ? undefined
              : await readRequestPrincipal(req),
          );
          const body = { ...req.query, ...req.body, ...req.params };
          const data =
            action === "capabilities"
              ? await memory.capabilities(identity)
              : action === "grant"
                ? await memory.grant(identity, body)
                : action === "revoke"
                  ? await memory.revoke(identity)
                  : await memory.execute(identity, action, body);
          res.json(ok(data));
        } catch (e) {
          next(e);
        }
      },
    );
  return router;
}
