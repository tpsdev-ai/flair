/**
 * flair#2764 against a real Harper started with FLAIR_REM_PAUSE=1. Each refused
 * request below sends a credential, so sendJsonRequest builds the error from
 * the response body: the message is a bounded `HTTP <status>: <reason>`, the
 * error keeps the body in its display form (a JSON body re-serialized), the
 * pair command's AccessViolation rewrite still recognises Harper's real 403
 * body, and rem's pause check still classifies the real /ReflectMemories 503.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { ApiHttpError, sendJsonRequest } from "../../src/lib/auth-resolve.ts";
import {
  FederationPairLocalAccessError,
  rewriteFederationPairLocalAccessError,
} from "../../src/lib/federation-pair-access.ts";
import { isNoBackendConfigured, isRemAbortedFailure } from "../../src/rem/runner.ts";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const [label, u] of [["http", http], ["ops", ops]] as const) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

const AGENT = mkAgent("agent-2764");
let harper: HarperInstance;

async function refused(path: string, authHeader: string, method = "GET", body?: unknown): Promise<ApiHttpError> {
  assertOwnInstance(harper);
  let caught: unknown;
  try {
    await sendJsonRequest(new URL(path, harper.httpURL), method, body, authHeader, true);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiHttpError);
  return caught as ApiHttpError;
}

/**
 * The reason expected in this suite's messages: the named error of a JSON body,
 * else the body itself. It neither bounds nor cleans the text, so it fits only
 * the short single-line Harper responses used here.
 */
function expectedReason(body: string): string {
  try {
    const parsed = JSON.parse(body);
    for (const key of ["error", "code", "message"]) {
      if (typeof parsed?.[key] === "string" && parsed[key]) return parsed[key];
    }
  } catch { /* not JSON */ }
  return body;
}

describe("flair#2764 — refused requests against a real Harper", () => {
  beforeAll(async () => {
    harper = await startHarper({ serverEnv: { FLAIR_REM_PAUSE: "1" } });
    assertOwnInstance(harper);
    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
    const res = await fetch(harper.opsURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
      },
      body: JSON.stringify({
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: AGENT.id, name: AGENT.id, role: "agent", publicKey: AGENT.publicKey, createdAt: new Date().toISOString() }],
      }),
    });
    expect(res.status).toBe(200);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  test("a non-admin agent's GET /FederationInstance: the message names Harper's error, the body is kept, the pair rewrite still fires", async () => {
    const err = await refused("/FederationInstance", ed25519Header(AGENT, "GET", "/FederationInstance"));
    const detail = `status ${err.status}, body ${JSON.stringify(err.body)}, message ${JSON.stringify(err.message)}`;
    expect(err.status, detail).toBe(403);
    expect(err.body, detail).toContain("AccessViolation");
    expect(err.message, detail).toBe(`HTTP 403: ${expectedReason(err.body!)}`);
    const rewritten = rewriteFederationPairLocalAccessError(err, { url: harper.httpURL, agentId: AGENT.id });
    expect(rewritten, detail).toBeInstanceOf(FederationPairLocalAccessError);
  }, 30_000);

  test("a wrong admin password: the message is the status plus Harper's error", async () => {
    const wrong = "Basic " + Buffer.from(`${harper.admin.username}:not-the-password`).toString("base64");
    const err = await refused("/Memory", wrong);
    const detail = `status ${err.status}, body ${JSON.stringify(err.body)}, message ${JSON.stringify(err.message)}`;
    expect([401, 403], detail).toContain(err.status);
    expect(err.message, detail).toBe(`HTTP ${err.status}: ${expectedReason(err.body!)}`);
    expect(err.message, detail).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
  }, 30_000);

  test("a paused instance's POST /ReflectMemories: rem's pause check classifies it, and the message is the bounded reason", async () => {
    const path = "/ReflectMemories";
    const err = await refused(path, ed25519Header(AGENT, "POST", path), "POST", { agentId: AGENT.id, execute: true });
    const detail = `status ${err.status}, body ${JSON.stringify(err.body)}, message ${JSON.stringify(err.message)}`;
    expect(err.status, detail).toBe(503);
    expect(err.message, detail).toBe("HTTP 503: rem_aborted");
    expect(JSON.parse(err.body!), detail).toEqual({
      error: "rem_aborted",
      detail: "REM distillation aborted (pause sentinel or FLAIR_REM_PAUSE=1). Resume with: flair rem resume",
    });
    expect(isRemAbortedFailure(err), detail).toBe(true);
    expect(isNoBackendConfigured(err), detail).toBe(false);
  }, 30_000);
});
