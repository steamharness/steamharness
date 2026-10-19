import { Router, type NextFunction, type Request, type Response } from "express";
import {
  AVATAR_FILE_PATTERN,
  AVATAR_USER_ID_PATTERN,
  type LocalStorage,
} from "../local-storage";
import { HttpError } from "../protocol";

/**
 * Public read surface for locally stored objects.
 *
 * Only mounted when the local storage driver is active, and deliberately scoped to
 * avatars: the route declares two anchored params and no wildcard, so private
 * objects (`storage/projects/**`) are unreachable through this public route.
 *
 * The shape here must match the avatar URL validator exactly — a URL this route
 * cannot serve would be rejected at upload time, and vice versa.
 */
export function createStorageAssetRouter(objectStorage: LocalStorage): Router {
  const router = Router();

  router.get("/avatars/:userId/:fileName", asyncHandler(async (req, res) => {
    const userId = req.params.userId;
    const fileName = req.params.fileName;
    // Express decodes percent-escapes after matching, so the pattern is what keeps
    // an encoded `../` out of the filesystem path.
    if (!AVATAR_USER_ID_PATTERN.test(userId) || !AVATAR_FILE_PATTERN.test(fileName)) {
      throw new HttpError(404, 404, "Avatar does not exist.");
    }

    const asset = await objectStorage.resolvePublicAvatar(userId, fileName);
    res.setHeader("Content-Type", asset.contentType);
    res.setHeader("Content-Length", String(asset.size));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", `"${asset.hash}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(asset.filePath);
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
