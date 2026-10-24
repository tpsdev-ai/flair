/**
 * admin-gate-inproc-2837.test.ts — flair#2837, against a REAL Harper.
 *
 * The admin-only gate (`allowAdmin`, resources/agent-auth.ts) reached through
 * Harper's own resource lifecycle by an in-process call. The inproc-app fixture
 * (test/fixtures/inproc-app/resources/AgentFleet.js, op `adminGate`) loads
 * Flair as a sub-component and calls Flair's Admin resource, whose allowRead()
 * is allowAdmin, with a static get() whose target asks Harper for the
 * permission check. Each call runs outside any request scope:
 *   (a) no context: Harper consults allowRead, and the gate refuses it;
 *   (b) `internalContext()`: admitted;
 *   (c) the internal marker on a context whose request carries headers: refused.
 *
 * Build prerequisite: dist/resources/*.js (`bun run build`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

let harper: HarperInstance;
let appDir = "";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error(`refusing to run against ${url}`);
    if (u.port === "9925" || u.port === "9926") throw new Error(`refusing to run against ${url}: not this test's own Harper`);
  }
  if (!h.process?.pid) throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

type GateResult = { admitted: boolean; status?: number | null; statusCode?: number | null; error?: string };

/** Drive the fixture's in-process `adminGate` op with one of its named contexts. */
async function gateInProcess(context: "none" | "internalContext" | "markerWithHeaders"): Promise<GateResult> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ op: "adminGate", context }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `AgentFleet answered ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  const envelope = JSON.parse(text);
  expect(envelope.ok, `the adminGate op failed: ${text.slice(0, 300)}`).toBe(true);
  return envelope.value;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  appDir = mkdtempSync(join(tmpdir(), "flair-2837-gate-app-"));
  await cp(join(process.cwd(), "test/fixtures/inproc-app"), appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules/@tpsdev-ai"), { recursive: true });
  await symlink(process.cwd(), join(appDir, "node_modules/@tpsdev-ai/flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd() });
  assertOwnInstance(harper);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2837 — allowAdmin through Harper's resource lifecycle, called in-process", () => {
  test("(a) a call with no context is refused by the gate", async () => {
    const result = await gateInProcess("none");
    expect(result.admitted, `a context-less call passed the admin gate: ${JSON.stringify(result)}`).toBe(false);
    // Harper's refusal for a context with no user is 401.
    expect(result.statusCode, JSON.stringify(result)).toBe(401);
  }, 60_000);

  test("(b) a deliberate internalContext() call is admitted", async () => {
    const result = await gateInProcess("internalContext");
    expect(result.admitted, `internalContext() was refused: ${JSON.stringify(result)}`).toBe(true);
    expect(result.status, "Admin.get()'s redirect").toBe(302);
  }, 60_000);

  test("(c) the internal marker on a context whose request carries headers is refused", async () => {
    const result = await gateInProcess("markerWithHeaders");
    expect(result.admitted, `a header-bearing marked context passed the admin gate: ${JSON.stringify(result)}`).toBe(false);
    expect(result.statusCode, JSON.stringify(result)).toBe(401);
  }, 60_000);
});
