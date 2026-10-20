import { spawn } from "node:child_process";

/**
 * Run an ffmpeg subprocess and resolve when it exits with code 0.
 *
 *  the bilibili downloader remuxes FLV / merges DASH audio+video
 * streams through this helper; the old frame capture path is gone.
 */
export function runFfmpeg(command: string, args: string[], signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    const abort = (): void => {
      child.kill("SIGTERM");
      reject(new Error("ffmpeg was aborted."));
    };

    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `ffmpeg exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
      ));
    });
  });
}

export async function resolveFfmpegPath(config: Record<string, unknown> = Object.fromEntries(["MINIMAX_API_KEY","MINIMAX_VIDEO_API_KEY","MINIMAX_BASE_URL","FFMPEG_PATH","FFMPEG_BIN"].map(key => [key, steamharness.getConfig<string>(key)]))): Promise<string> {
  const explicit = readString(config.FFMPEG_PATH) ?? readString(config.FFMPEG_BIN);
  if (explicit !== undefined) {
    return explicit;
  }

  const installerPath = await resolveFfmpegInstallerPath();
  if (installerPath !== undefined) {
    return installerPath;
  }

  try {
    const mod = await import("ffmpeg-static");
    const value = typeof mod.default === "string" ? mod.default : undefined;
    if (value !== undefined && value.trim() !== "") {
      return value;
    }
  } catch {
    // ffmpeg-static not installed; fall through to PATH lookup.
  }

  return "ffmpeg";
}

async function resolveFfmpegInstallerPath(): Promise<string | undefined> {
  try {
    const mod = (await import("@ffmpeg-installer/ffmpeg")) as { default?: unknown; path?: unknown };
    const candidate = mod.default ?? mod;
    if (typeof candidate === "object" && candidate !== null && "path" in candidate) {
      const path = (candidate as { path?: unknown }).path;
      if (typeof path === "string" && path.trim() !== "") {
        return path;
      }
    }
  } catch {
    // @ffmpeg-installer/ffmpeg not installed.
  }
  return undefined;
}

function readString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
