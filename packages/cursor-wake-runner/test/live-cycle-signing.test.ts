/**
 * live-cycle-signing.test.ts — flair#1944 round 9 (slice 2 of flair#1940).
 *
 * The exported live cycle loads and validates the signing key before building
 * its parts or sending requests.
 *
 * Every HTTP target here is a loopback stub this file started (http on 127.0.0.1,
 * so admin Basic is allowed over it). The live case must reach it ZERO times; the
 * dry-run case drains the feed once with no Cursor create, receipt write or ack.
 * A real catchup read may create an AgentReadPosition.
 *
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

  test("--dry-run with Basic-only credentials drains the feed once with no Cursor create, receipt write or ack", async () => {
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
