/**
 * live-cycle-signing.test.ts — flair#1944 round 9 (slice 2 of flair#1940).
 *
 * Round 4 refused a live cycle with no signing key at CLI startup; round 5
 * enforced the requirement WHERE THE WRITE happens. Neither closed the gap
 * Codex found: a caller that drives the EXPORTED `runWakeCycle` directly with
 * admin Basic credentials could still DRAIN the feed and LAUNCH Cursor, and only
 * AFTERWARDS fail the receipt write for lack of a signing key — a real launch left
 * unrecorded, the watermark unadvanced (catchup.ts carries no signing requirement;
 * it is set only on the write, receipt-store.ts).
 *
 * Round 9 enforces the requirement at the START of a live cycle in the EXPORTED
 * runner: `runWakeCycle` refuses, by name, BEFORE it builds any part or makes any
 * request — no catchup read, no Cursor launch, no receipt write.
 *
 * Every HTTP target here is a loopback stub this file started (http on 127.0.0.1,
 * so admin Basic is allowed over it). The live case must reach it ZERO times; the
 * dry-run case drains the feed once and writes nothing.
 *
 * MUTATION (flair#1944 round 9): remove the `assertLiveCycleSigningKey` call from
 * `runWakeCycle` (i.e. move the check back to write time, where only the store
 * requires it). The live case then drains the feed, launches Cursor, and fails
 * the write afterwards — the stub records the GET + POST — and the first test
 * fails. Run and restored.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FlairClient } from "@tpsdev-ai/flair-client";
import { runWakeCycle } from "../src/index.ts";

let server: Server;
let base: string;
let requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(`${req.method} ${url}`);
    req.on("data", () => {});
    req.on("end", () => {
      // The catchup feed serves ONE directed event for whichever agent's feed it
      // is asked for. If the live case ever reached here, the cycle would launch
      // (POST /v1/agents) and then attempt the receipt write.
      if (req.method === "GET" && url.startsWith("/OrgEventCatchup/")) {
        const agentId = decodeURIComponent(url.split("/")[2] ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            events: [
              {
                id: "evt-1",
                kind: "coord.dispatch",
                summary: "a light brief",
                detail: "https://github.com/example-org/example-repo/issues/7",
                targetIds: [agentId],
                authorId: "agent-b",
                position: "p1",
              },
            ],
            hasMore: false,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agent: { id: "bc-x", url: "https://cursor.example/agents/bc-x" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect(new URL(base).hostname, "the stub is loopback so Basic over http is allowed").toBe("127.0.0.1");
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Admin Basic credentials and NO signing key for this id. */
function basicOnlyClient(agentId: string): FlairClient {
  return new FlairClient({
    agentId,
    url: base,
    keyPath: join(tmpdir(), `absent-${randomUUID()}.key`),
    adminUser: "admin",
    adminPassword: "secret",
  });
}

describe("flair#1944 round 9 — a LIVE cycle refuses a Basic-only client BEFORE any read or launch", () => {
  test("runWakeCycle with a Basic-only client: refused by name, ZERO requests to catchup or Cursor", async () => {
    requests = [];
    const client = basicOnlyClient(`agent-live-start-${randomUUID()}`);
    const cursor = { apiBase: base, apiKey: "k" };

    let refused: unknown;
    try {
      await runWakeCycle({ client, cursor });
    } catch (err) {
      refused = err;
    }

    expect(refused, "a live run with no signing key must be refused").toBeInstanceOf(Error);
    expect((refused as Error).message, "the refusal names the signing key").toContain(
      "live receipts need the agent's signing key",
    );
    expect(requests, "the refusal is BEFORE any request — nothing read, nothing launched, nothing written").toEqual([]);
  });

  test("--dry-run with Basic-only credentials still runs (read-only): the feed is drained once and nothing is written", async () => {
    requests = [];
    const client = basicOnlyClient(`agent-dry-start-${randomUUID()}`);

    const result = await runWakeCycle({ client, cursor: { apiBase: base, apiKey: "k" }, dryRun: true });

    expect(result.items[0]?.action, "the dry-run client classified, no launch").toBe("dry-run");
    expect(result.acked, "a dry-run cycle acks nothing").toBeNull();
    expect(
      requests.filter((line) => line.startsWith("GET /OrgEventCatchup/")),
      "the dry-run drains the feed",
    ).toHaveLength(1);
    expect(requests.some((line) => line.startsWith("POST ")), "a dry-run launches nothing").toBe(false);
    expect(requests.some((line) => line.startsWith("PUT ")), "a dry-run writes no receipt").toBe(false);
  });
});
