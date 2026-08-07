/**
 * Unit tests for the boot readiness gate in boot-harper.mjs.
 *
 * The gate verifies that the Flair application is actually loaded — not just
 * that Harper's /health returns 200. A half-booted instance (server up, app
 * absent) must fail loudly rather than handing tests a 404-serving URL.
 */
import { test, expect } from "bun:test";
import { createServer } from "node:http";
import type { Server } from "node:http";

/**
 * Replicated from boot-harper.mjs — kept in sync manually.
 * Polls a Flair-owned route until it returns non-404 or times out.
 */
async function waitForAppLoaded(
  httpURL: string,
  timeoutMs = 5_000,
): Promise<void> {
  const url = `${httpURL}/Memory`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(1000),
      });
      if (res.status !== 404) {
        return;
      }
    } catch {
      // connection refused / timeout — keep polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Flair application not loaded at ${httpURL} after ${timeoutMs}ms ` +
      `(${attempt} attempts). The Flair app must be built before running ` +
      `integration tests — Harper is up but /Memory returns 404.`,
  );
}

/** Start a mock server on an ephemeral port. */
function startMock(
  handler: (req: { url?: string }, res: { statusCode: number; end: (body?: string) => void }) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler as any);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("failed to get server address");
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test("waitForAppLoaded resolves when /Memory returns non-404", async () => {
  const { server, url } = await startMock((_req, res) => {
    res.statusCode = 405; // Method Not Allowed — app is loaded, just wrong method
    res.end();
  });

  try {
    await waitForAppLoaded(url, 3_000);
    // Should not throw
  } finally {
    server.close();
  }
});

test("waitForAppLoaded resolves when /Memory returns 200", async () => {
  const { server, url } = await startMock((_req, res) => {
    res.statusCode = 200;
    res.end("[]");
  });

  try {
    await waitForAppLoaded(url, 3_000);
  } finally {
    server.close();
  }
});

test("waitForAppLoaded throws when /Memory returns 404 (app not loaded)", async () => {
  const { server, url } = await startMock((_req, res) => {
    if (_req.url === "/health") {
      res.statusCode = 200;
      res.end("OK");
    } else {
      // Harper's catch-all when no app handles the route
      res.statusCode = 404;
      res.end("Not Found");
    }
  });

  try {
    await expect(waitForAppLoaded(url, 2_000)).rejects.toThrow(
      "Flair application not loaded",
    );
  } finally {
    server.close();
  }
});

test("waitForAppLoaded throws when server is unreachable", async () => {
  // Use a port that nothing is listening on
  await expect(waitForAppLoaded("http://127.0.0.1:1", 1_000)).rejects.toThrow(
    "Flair application not loaded",
  );
});

test("waitForAppLoaded eventually resolves when app loads after delay", async () => {
  let callCount = 0;
  const { server, url } = await startMock((_req, res) => {
    callCount++;
    if (callCount <= 3) {
      // First 3 calls: app not loaded yet
      res.statusCode = 404;
      res.end("Not Found");
    } else {
      // App loads on 4th call
      res.statusCode = 200;
      res.end("[]");
    }
  });

  try {
    await waitForAppLoaded(url, 5_000);
    expect(callCount).toBeGreaterThanOrEqual(4);
  } finally {
    server.close();
  }
});
