import { Router, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "../protocol";
import type { WorkflowStorage } from "../storage";

const PROJECT_CARD_IMAGE_FILE_PATTERN = /^([a-f0-9]{64})\.webp$/;

export function createProjectCardImageRouter(storage: WorkflowStorage): Router {
  const router = Router();

  router.get("/:workflowId/:fileName", asyncHandler(async (req, res) => {
    const match = PROJECT_CARD_IMAGE_FILE_PATTERN.exec(req.params.fileName);
    if (!match?.[1]) {
      throw new HttpError(404, 404, "Project card image does not exist.");
    }
    const image = await storage.getProjectCardImage(req.params.workflowId, match[1]);
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Content-Length", String(image.size));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", `"${image.hash}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(image.filePath);
  }));

  return router;
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
