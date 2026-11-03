// agent-key-floor-real-2955.test.ts — flair#2955, against a REAL Harper.
//
// Tier 5 of src/lib/auth-resolve.ts (`tryAgentKeyFloor`) must move past a key
// the server refused as a CREDENTIAL (401 unknown_agent) and must treat a
// policy refusal of a request that key signed as FINAL, with exactly one
// attempt against the server.
//
// Each case drives this instance's own ephemeral Harper through
// `tryAgentKeyFloor` itself with key files in a scratch keys directory:
//   1. an unregistered key (401 unknown_agent) followed by a registered key
//      whose own Memory write succeeds — the floor moves on;
//   2. only the registered key, whose write names another principal's
//      agentId — the server refuses it on policy (403) and the floor makes
//      exactly one signed attempt, surfacing that refusal.
//
// BUILD PREREQUISITE: dist/resources/*.js (`bun run build`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import {
  startHarper,
  stopHarper,
  type HarperInstance,
  HARPER_START_BUDGET_MS,
  HARPER_STOP_BUDGET_MS,
} from "../helpers/harper-lifecycle";
import { tempDir } from "../helpers/temp-dir.ts";
import { ApiHttpError, apiErrorRawBody, tryAgentKeyFloor } from "../../src/lib/auth-resolve.ts";

const sfx = Date.now().toString(36);
const REGISTERED_ID = `agent-floor-${sfx}`;

let harper: HarperInstance;
let homeDir: string;
let savedHome: string | undefined;
let registeredKey: nacl.SignKeyPair;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], `${url} must be this test's own Harper`).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  expect(h.installDir.startsWith(tmpdir()), `${h.installDir} must be this test's own temp tree`).toBe(true);
}

const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ database: "flair", ...op }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}

function writeAgentKey(keysDir: string, agentId: string, keyPair: nacl.SignKeyPair): void {
  mkdirSync(keysDir, { recursive: true });
  const path = join(keysDir, `${agentId}.key`);
  writeFileSync(path, Buffer.from(keyPair.secretKey.slice(0, 32)));
  chmodSync(path, 0o600);
}

function agentOf(authorization: string | undefined): string | undefined {
  if (typeof authorization !== "string" || !authorization.startsWith("TPS-Ed25519 ")) return undefined;
  return authorization.slice("TPS-Ed25519 ".length).split(":")[0];
}

interface SignedAttempt { agentId: string | undefined }

/** Run `request` while recording every fetch the floor sends, then restore fetch. */
async function recordingRequests<T>(request: () => Promise<T>): Promise<{ result: T; signed: SignedAttempt[] }> {
  const origFetch = globalThis.fetch;
  const signed: SignedAttempt[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    signed.push({ agentId: agentOf(init?.headers?.authorization) });
    return origFetch(input, init);
  }) as unknown as typeof fetch;
  try {
    const result = await request();
    return { result, signed: signed.filter((s) => s.agentId !== undefined) };
  } finally {
    globalThis.fetch = origFetch;
  }
}

function errorCodeOf(err: unknown): string | undefined {
  const raw = apiErrorRawBody(err);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

describe("flair#2955 — the agent-key floor against a real Harper", () => {
  beforeAll(async () => {
    if (process.env.HARPER_HTTP_URL) throw new Error("agent-key-floor-real-2955 requires an isolated Harper instance; unset HARPER_HTTP_URL");
    homeDir = tempDir("flair-2955-home-");
    savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    harper = await startHarper();
    assertOwnInstance(harper);
    registeredKey = nacl.sign.keyPair();
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{
        id: REGISTERED_ID,
        name: REGISTERED_ID,
        role: "agent",
        status: "active",
        publicKey: Buffer.from(registeredKey.publicKey).toString("base64url"),
        createdAt: new Date().toISOString(),
      }],
    });
  }, HARPER_START_BUDGET_MS);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }, HARPER_STOP_BUDGET_MS);

  test("an unregistered key is refused as a credential and the floor moves to the registered key", async () => {
    const keysDir = tempDir("flair-2955-keys-moveon-");
    writeAgentKey(keysDir, "a-unregistered", nacl.sign.keyPair());
    writeAgentKey(keysDir, REGISTERED_ID, registeredKey);

    const { result, signed } = await recordingRequests(() =>
      tryAgentKeyFloor(new URL(`${harper.httpURL}/Memory`), "POST", { agentId: REGISTERED_ID, content: `floor move-on ${sfx}` }, keysDir),
    );
    expect(signed.map((s) => s.agentId)).toEqual(["a-unregistered", REGISTERED_ID]);
    expect(result).toBeDefined();
  }, 30_000);

  test("a registered key's policy-refused write gets exactly one attempt and surfaces the server's 403", async () => {
    const keysDir = tempDir("flair-2955-keys-policy-");
    writeAgentKey(keysDir, REGISTERED_ID, registeredKey);

    const { signed, result } = await recordingRequests(() =>
      tryAgentKeyFloor(new URL(`${harper.httpURL}/Memory`), "POST", { agentId: "agent-other", content: `floor policy ${sfx}` }, keysDir).then(
        (value) => ({ threw: false, value }),
        (err: unknown) => ({ threw: true, err }),
      ),
    );
    expect(signed.map((s) => s.agentId)).toEqual([REGISTERED_ID]);
    expect((result as any).threw).toBe(true);
    const err = (result as any).err;
    expect(err).toBeInstanceOf(ApiHttpError);
    expect((err as ApiHttpError).status).toBe(403);
    expect((err as ApiHttpError).noCredentials).toBe(false);
    expect(errorCodeOf(err)).toBe("forbidden: cannot write memory owned by another agent");
  }, 30_000);
});
