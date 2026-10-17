import type { RequestHandler } from "express";
import { fail } from "./protocol";

/**
 * The public Server deliberately has no system-AI implementation. Internal
 * deployments mount the private gateway separately, so callers that use the
 * public base URL receive a stable, explicit response.
 */
export function createPublicSystemAiUnavailableHandler(): RequestHandler {
  return (_req, res) => {
    res.status(404).json(fail(404, "System AI is unavailable on the public Server."));
  };
}
