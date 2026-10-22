// signed-only-hint-2749.test.ts — flair#2749, on real Harper.
//
// A `signedOnly` request with no agent key sends no Authorization header. Real
// Harper refuses an anonymous read of /Memory with 403, and `authedRequest`
// must report that 403 with the signed-only hint and `noCredentials`. A raw
// anonymous request to the same route records the body shape Harper sends. The keys directory each request falls back to is an
// empty temp directory, so the agent-key fallback finds no key.
//
// MODEL: test/integration/auth-middleware-e2e.test.ts (real Harper, an
// anonymous /Memory read refused with 403).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { tempDir } from "../helpers/temp-dir.ts";
import { ApiHttpError, authedRequest } from "../../src/lib/auth-resolve.ts";

const SIGNED_ONLY = "HTTP 403: no credentials sent. This request can send only an Ed25519 agent signature; the admin password is not sent on this path. ";
const ROUTE = "/Memory/?agentId=agent-2749";

let harper: HarperInstance;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

async function refusal(promise: Promise<unknown>): Promise<ApiHttpError> {
  const err = await promise.then(
    () => { throw new Error("expected the request to be refused"); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiHttpError);
  return err as ApiHttpError;
}

describe("flair#2749 — the signed-only 403 hint against real Harper", () => {
  beforeAll(async () => {
    if (process.env.HARPER_HTTP_URL) throw new Error("signed-only-hint-2749 requires an isolated Harper instance; unset HARPER_HTTP_URL");
    harper = await startHarper();
    assertOwnInstance(harper);
  }, HARPER_START_BUDGET_MS);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, HARPER_STOP_BUDGET_MS);

  test("Harper refuses an anonymous /Memory read with 403 (records the body shape)", async () => {
    const res = await fetch(`${harper.httpURL}${ROUTE}`);
    const text = await res.text();
    console.log(
      `[flair#2749] anonymous GET ${ROUTE}: status=${res.status} content-length=${res.headers.get("content-length")} ` +
        `content-type=${res.headers.get("content-type")} body-bytes=${Buffer.byteLength(text)}`,
    );
    expect(res.status).toBe(403);
  }, 30_000);

  test("a signed-only request with no agent key gets the signed-only hint and noCredentials", async () => {
    const keysDir = tempDir("flair-2749-keys-");
    const err = await refusal(authedRequest("GET", ROUTE, undefined, { baseUrl: harper.httpURL, keysDir, signedOnly: true }));
    expect(err.status).toBe(403);
    expect(err.noCredentials).toBe(true);
    expect(err.message).toBe(`${SIGNED_ONLY}Provide the key of an agent registered on the target instance at ${join(keysDir, "<agent-id>.key")}.`);
  }, 30_000);

  test("a signed-only request naming an agent with no key gets that agent's key path and noCredentials", async () => {
    const keysDir = tempDir("flair-2749-keys-");
    const err = await refusal(
      authedRequest("GET", ROUTE, undefined, { baseUrl: harper.httpURL, keysDir, agentId: "agent-2749", agentIdSource: "env", signedOnly: true }),
    );
    expect(err.status).toBe(403);
    expect(err.noCredentials).toBe(true);
    expect(err.message).toBe(
      `${SIGNED_ONLY}Provide the key of agent 'agent-2749' at ${join(process.env.HOME!, ".flair", "keys", "agent-2749.key")} ` +
        "(or set FLAIR_KEY_DIR to a directory containing agent-2749.key).",
    );
  }, 30_000);
});
