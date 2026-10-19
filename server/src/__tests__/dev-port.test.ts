import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import test from "node:test";
import { isAddressInUseError, listenServerWithDevPortFallback } from "../dev-port";

test("listenServerWithDevPortFallback tries the next port in dev mode", async () => {
  const basePort = await findFreePortPair();
  const blocker = createServer((_req, res) => res.end("busy"));
  const server = createServer((_req, res) => res.end("ok"));
  const warnings: string[] = [];

  try {
    await listen(blocker, basePort);

    const actualPort = await listenServerWithDevPortFallback(server, {
      port: basePort,
      isDev: true,
      maxAttempts: 2,
      logger: {
        warn: (message: unknown) => warnings.push(String(message)),
      },
    });

    // covers dev server recovery when the configured port is busy.
    assert.equal(actualPort, basePort + 1);
    assert.deepEqual(warnings, [`[steamharness-server] port ${basePort} is in use; trying ${basePort + 1}.`]);
  } finally {
    await closeServer(server);
    await closeServer(blocker);
  }
});

test("listenServerWithDevPortFallback preserves EADDRINUSE failures outside dev mode", async () => {
  const basePort = await findFreePortPair();
  const blocker = createServer((_req, res) => res.end("busy"));
  const server = createServer((_req, res) => res.end("ok"));

  try {
    await listen(blocker, basePort);

    await assert.rejects(
      listenServerWithDevPortFallback(server, {
        port: basePort,
        isDev: false,
      }),
      (error) => isAddressInUseError(error),
    );
  } finally {
    await closeServer(server);
    await closeServer(blocker);
  }
});

test("listenServerWithDevPortFallback preserves EADDRINUSE failures in strict dev mode", async () => {
  const basePort = await findFreePortPair();
  const blocker = createServer((_req, res) => res.end("busy"));
  const server = createServer((_req, res) => res.end("ok"));

  try {
    await listen(blocker, basePort);

    await assert.rejects(
      listenServerWithDevPortFallback(server, {
        port: basePort,
        isDev: true,
        strictPort: true,
        maxAttempts: 2,
      }),
      (error) => isAddressInUseError(error),
    );
  } finally {
    await closeServer(server);
    await closeServer(blocker);
  }
});

async function findFreePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await getRandomFreePort();
    if (port > 0 && (await canListen(port + 1))) {
      return port;
    }
  }

  throw new Error("Unable to find two adjacent free ports for dev port fallback test.");
}

async function getRandomFreePort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await closeServer(server);
  return port;
}

async function canListen(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await listen(server, port);
    return true;
  } catch {
    return false;
  } finally {
    await closeServer(server);
  }
}

function listen(server: HttpServer, port: number): Promise<void> {
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
    server.listen(port);
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
