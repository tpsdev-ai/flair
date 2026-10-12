/**
 * live-credentials.test.ts — flair#1944 round 4 (slice 2 of flair#1940).
 *
 * The shipped CLI refuses a live cycle without a signing key before requests.
 * Dry-run with Basic credentials performs no Cursor create, receipt write or ack;
 * a real catchup read may create an AgentReadPosition.
 *
 * Every HTTP target here is a loopback stub this file started: the live case must
 * reach it ZERO times (the refusal happens first), the dry-run reads it once.
 *
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { main } from "../src/cli.ts";

let server: Server;
let base: string;
let requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url ?? ""}`);
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events: [], hasMore: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect(new URL(base).hostname, "the stub is loopback so Basic over http is allowed").toBe("127.0.0.1");
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The env keys the CLI reads; each is cleared, set from `vars`, then restored. */
const ENV_KEYS = [
  "FLAIR_AGENT_ID",
  "FLAIR_URL",
  "FLAIR_KEY_PATH",
  "FLAIR_KEY_DIR",
  "FLAIR_ADMIN_USER",
  "FLAIR_ADMIN_PASSWORD",
  "CURSOR_API_KEY",
  "CURSOR_API_BASE",
  "CURSOR_ENV_NAME",
  "CURSOR_ENV_TYPE",
  "CURSOR_REPO_URL",
  "CURSOR_STARTING_REF",
  "CURSOR_AUTO_CREATE_PR",
  "FLAIR_CATCHUP_BACKFILL_MS",
];

async function withEnv(vars: Record<string, string>, fn: () => Promise<number>): Promise<number> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Admin Basic credentials and NO signing key for this id. */
function basicOnlyEnv(agentId: string): Record<string, string> {
  return {
    FLAIR_AGENT_ID: agentId,
    FLAIR_URL: base,
    FLAIR_KEY_PATH: join(tmpdir(), `absent-${randomUUID()}.key`),
    FLAIR_ADMIN_USER: "admin",
    FLAIR_ADMIN_PASSWORD: "secret",
    CURSOR_API_KEY: "test-key",
    CURSOR_API_BASE: base,
  };
}

describe("flair#1944 round 4 — a live receipt run needs the agent's signing key", () => {
  test("the CLI refuses a LIVE cycle with Basic-only credentials, before reading or acking", async () => {
    requests = [];
    let refused: unknown;
    try {
      await withEnv(basicOnlyEnv("agent-basic-live"), () => main(["--once"]));
    } catch (err) {
      refused = err;
    }

    expect(refused, "a live run with no signing key must be refused").toBeInstanceOf(Error);
    expect((refused as Error).message, "the refusal names the signing key").toContain(
      "live receipts need the agent's signing key",
    );
    expect(requests, "the refusal happens before any request — nothing read, nothing acked").toEqual([]);
  });

  test("the CLI still runs --dry-run with Basic-only credentials (no Cursor create, receipt write or ack)", async () => {
    requests = [];
    const code = await withEnv(basicOnlyEnv("agent-basic-dry"), () => main(["--once", "--dry-run"]));

    expect(code, "the guard must not refuse a dry-run").toBe(0);
    expect(
      requests.some((line) => line.startsWith("GET /OrgEventCatchup/")),
      "the dry-run drains the feed",
    ).toBe(true);
    expect(requests.some((line) => line.startsWith("POST ")), "a dry-run acks nothing").toBe(false);
  });
});
