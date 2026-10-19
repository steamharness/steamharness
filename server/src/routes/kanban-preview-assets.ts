import { Router, type NextFunction, type Request, type Response } from "express";
import type { Storage } from "../storage";

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

export function createKanbanPreviewAssetRouter(storage: Storage): Router {
  const router = Router();

  router.get(
    "/workflows/:workflowName/kanban/previews/:capability/:nonce/:target/*",
    asyncHandler(async (req, res) => {
      // The short-lived capability is the credential for sandboxed
      // iframe subresources, which cannot inherit the App's authenticated session.
      const asset = await storage.getKanbanAsset({
        workflowName: req.params.workflowName,
        target: req.params.target,
        previewCapabilityToken: req.params.capability,
        assetPath: req.params[0] ?? "",
        nonce: req.params.nonce,
      });
      res.status(200);
      res.setHeader("Content-Type", asset.contentType);
      res.setHeader("Content-Length", String(asset.contentLength));
      res.setHeader("Content-Security-Policy", asset.contentSecurityPolicy);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(asset.content);
    }),
  );

  return router;
}
