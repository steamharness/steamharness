import { Router } from "express";
import { getRequestT, localizeServerMessage } from "../i18n";
import { fail } from "../protocol";

export function createRemovedApiRouter(): Router {
  const router = Router();
  // Leave the Web list page (GET and HEAD) to the HTML fallback.
  router.get("/projects", (_req, _res, next) => next("router"));
  router.use(["/v1", "/webhooks", "/projects"], (req, res) => {
    res.status(404).json(fail(404, localizeServerMessage("API route not found.", getRequestT(req))));
  });
  return router;
}
