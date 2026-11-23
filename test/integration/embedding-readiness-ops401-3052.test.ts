/**
 * embedding-readiness-ops401-3052.test.ts — the readiness helper's ops 401
 * fallback against a real Harper (flair#3052).
 *
 * `opsPost` retries a 401 once without `Authorization`, for a Harper whose
 * `authentication.authorizeLocal` accepts a credential-less loopback call. This
 * instance runs with AUTHENTICATION_AUTHORIZELOCAL=true, so a wrong Basic
 * credential is refused with 401 on the operations API and the credential-less
 * retry is admitted. The test proves both legs on the real server, then runs
 * the helper's agent create and row read-back through the fallback.
 *
 * Real Harper answers both legs in milliseconds, so the shared client bound
 * across the two legs is tested against a delayed local server instead
 * (test/unit/embedding-readiness-timeout-3052.test.ts).
 *
 * Throwaway HOME + data dir, ephemeral ports; every URL is asserted to be this
 * test's own instance.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { createWarmAgent, opsPost } from "../../scripts/ci/embedding-readiness.mjs";

const WRONG_AUTH = `Basic ${Buffer.from("admin:not-the-admin-password").toString("base64")}`;

let harper: HarperInstance;
let authHeader: string;

function rawOps(body: Record<string, unknown>, auth?: string): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper({ serverEnv: { AUTHENTICATION_AUTHORIZELOCAL: "true" } });
  authHeader = `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64")}`;

  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const url of [http, ops]) {
    if (url.hostname !== "127.0.0.1" || !(Number(url.port) > 0) || url.port === "9925" || url.port === "9926") {
      throw new Error(`refusing to run against ${url.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.ownsInstallDir || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
}, HARPER_STOP_BUDGET_MS);

describe("flair#3052 — the ops 401 fallback against a real Harper", () => {
  it("the first leg answers 401 and the credential-less leg is admitted", async () => {
    const probe = { operation: "describe_table", database: "flair", table: "Agent" };
    const wrong = await rawOps(probe, WRONG_AUTH);
    expect(wrong.status, await wrong.text()).toBe(401);
    const bare = await rawOps(probe);
    expect(bare.status, await bare.text()).toBe(200);
  }, 30_000);

  it("the helper creates its agent and reads a row back through the fallback", async () => {
    const agentId = await createWarmAgent(harper.opsURL, WRONG_AUTH);
    try {
      const text = await opsPost(harper.opsURL, WRONG_AUTH, {
        operation: "search_by_id", database: "flair", table: "Agent",
        ids: [agentId], get_attributes: ["id"],
      });
      expect(JSON.parse(text)).toEqual([{ id: agentId }]);

      // The row is real: the correctly credentialed caller sees it too.
      const check = await rawOps({
        operation: "search_by_id", database: "flair", table: "Agent",
        ids: [agentId], get_attributes: ["id"],
      }, authHeader);
      expect(check.status).toBe(200);
      expect(await check.json()).toEqual([{ id: agentId }]);
    } finally {
      const del = await rawOps({ operation: "delete", database: "flair", table: "Agent", ids: [agentId] }, authHeader);
      expect(del.status, await del.text()).toBe(200);
    }
  }, 30_000);
});
