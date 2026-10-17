import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";

/**
 * Development listens on the loopback port next to PostgreSQL's 7125; the
 * release/deploy band starts at 7130. Kept here rather than in the entry point
 * so other modules can resolve the same default without importing `index.ts`.
 */
export const DEFAULT_DEV_SERVER_PORT = 7126;
export const DEFAULT_PRODUCTION_SERVER_PORT = 7130;

type Logger = Pick<typeof console, "warn">;

export async function listenServerWithDevPortFallback(
  server: HttpServer,
  options: {
    port: number;
    host?: string;
    isDev: boolean;
    strictPort?: boolean;
    maxAttempts?: number;
    logger?: Logger;
  },
): Promise<number> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 20);
  let port = options.port;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await listenOnce(server, { port, host: options.host });
      return readListeningPort(server, port);
    } catch (error) {
      if (!options.isDev || options.strictPort || !isAddressInUseError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const nextPort = port + 1;
      options.logger?.warn(`[workflow-server] port ${port} is in use; trying ${nextPort}.`);
      port = nextPort;
    }
  }

  throw new Error(`Failed to listen after ${maxAttempts} attempts.`);
}

export function isAddressInUseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

function listenOnce(server: HttpServer, options: { port: number; host?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);

    try {
      if (options.host) {
        server.listen(options.port, options.host);
      } else {
        server.listen(options.port);
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function readListeningPort(server: HttpServer, fallback: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? (address as AddressInfo).port : fallback;
}
