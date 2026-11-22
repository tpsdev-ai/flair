/**
 * idp-test-real-harper-2889.test.ts — flair#2889
 *
 * `flair idp test <id> --admin-pass-file <file>` reads the IdpConfig row
 * through the real IdpConfig REST resource of a throwaway Harper, then fetches
 * the row's JWKS from a local endpoint. Cases: the row exists (JWKS fetched,
 * key count reported), the row is missing (not found, JWKS not fetched), and
 * the file holds a wrong password (the refusal is reported as the error, not
 * as not found, JWKS not fetched).
 *
 * Both the Harper install dir and the CLI HOME are fresh temp trees; the CLI
 * is pointed at the instance's HTTP URL and ops port explicitly.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCli } from "../helpers/build-cli-once.ts";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.ts";
import {
  HARPER_START_BUDGET_MS,
  HARPER_STOP_BUDGET_MS,
  startHarper,
  stopHarper,
  type HarperInstance,
} from "../helpers/harper-lifecycle.ts";

const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 30_000;
const IDP_ID = "idp_real2889";
const MISSING_ID = "idp_absent2889";
const IDP_NAME = "Real Harper fixture";
const FORBIDDEN_PORTS = ["9925", "9926"];

let harper: HarperInstance;
let jwks: ReturnType<typeof Bun.serve> | undefined;
let jwksFetches = 0;
let cliHome: string;
let passFile: string;
let wrongPassFile: string;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function assertEphemeralTarget(url: string, instanceUrl: string): void {
  const target = new URL(url);
  expect(target.origin).toBe(new URL(instanceUrl).origin);
  expect(target.hostname).toBe("127.0.0.1");
  expect(FORBIDDEN_PORTS).not.toContain(target.port);
}

function runIdpTest(id: string, file: string): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key) && key !== "ROOTPATH")),
    HOME: cliHome,
    USERPROFILE: cliHome,
    FLAIR_URL: harper.httpURL,
  };
  assertEphemeralTarget(env.FLAIR_URL!, harper.httpURL);
  for (const key of ["FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_TOKEN", "FLAIR_AGENT_ID", "FLAIR_ADMIN_USER"]) {
    expect(env).not.toHaveProperty(key);
  }
  const args = [
    "idp", "test", id,
    "--admin-pass-file", file,
    "--admin-user", harper.admin.username,
    "--ops-port", new URL(harper.opsURL).port,
  ];
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawnCli(args, { env, timeout: CHILD_DEADLINE_MS, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, {
          status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr,
        })));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("idp-test-real-harper-2889 requires an isolated Harper instance; unset HARPER_HTTP_URL");
  harper = await startHarper();
  expect(harper.external).toBe(false);
  for (const url of [harper.httpURL, harper.opsURL]) {
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect(Number(new URL(url).port)).toBeGreaterThan(0);
    expect(FORBIDDEN_PORTS).not.toContain(new URL(url).port);
  }

  jwks = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/jwks") return new Response("unexpected path", { status: 500 });
      jwksFetches++;
      return Response.json({ keys: [{ kty: "EC", kid: "key-a" }, { kty: "EC", kid: "key-b" }] });
    },
  });

  cliHome = mkdtempSync(join(tmpdir(), "flair-idp-real-home-"));
  mkdirSync(join(cliHome, ".flair"));
  writeFileSync(
    join(cliHome, ".flair", "config.yaml"),
    `port: ${new URL(harper.httpURL).port}\nopsPort: ${new URL(harper.opsURL).port}\n`,
  );
  passFile = join(cliHome, "admin-pass");
  writeFileSync(passFile, `${harper.admin.password}\n`, { mode: 0o600 });
  wrongPassFile = join(cliHome, "wrong-admin-pass");
  writeFileSync(wrongPassFile, "not-the-admin-password\n", { mode: 0o600 });

  // Seed the row the way `flair idp add` writes it: an operations-API upsert.
  assertEphemeralTarget(harper.opsURL, harper.opsURL);
  const now = new Date().toISOString();
  const seeded = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64")}`,
    },
    body: JSON.stringify({
      operation: "upsert", database: "flair", table: "IdpConfig",
      records: [{
        id: IDP_ID, name: IDP_NAME, issuer: "https://idp.example",
        jwksUri: `http://127.0.0.1:${jwks.port}/jwks`, clientId: "idp-real-2889-client",
        requiredDomain: null, jitProvision: true, defaultTrustTier: "unverified", enabled: true,
        createdAt: now, updatedAt: now,
      }],
    }),
  });
  const seededBody = await seeded.text();
  expect(seeded.status, seededBody).toBe(200);
  expect(seededBody).toContain(IDP_ID);
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  if (jwks) await jwks.stop(true);
  if (harper) await stopHarper(harper);
  if (cliHome) rmSync(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2889 — idp test reads IdpConfig through Harper with --admin-pass-file", () => {
  test("an existing row: exit 0, the JWKS endpoint is fetched and its key count reported", async () => {
    const before = jwksFetches;
    const result = await runIdpTest(IDP_ID, passFile);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Testing IdP: ${IDP_NAME} (https://idp.example)`);
    expect(result.stdout).toContain("JWKS reachable — 2 key(s) found");
    expect(jwksFetches).toBe(before + 1);
  }, CASE_BUDGET_MS);

  test("a missing row: not found, non-zero exit, the JWKS endpoint is not fetched", async () => {
    const before = jwksFetches;
    const result = await runIdpTest(MISSING_ID, passFile);
    expect(result.code, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stderr.trim()).toBe(`IdP '${MISSING_ID}' not found`);
    expect(jwksFetches).toBe(before);
  }, CASE_BUDGET_MS);

  test("a wrong password in the file: the refusal is the error, not not-found, and the JWKS endpoint is not fetched", async () => {
    const before = jwksFetches;
    const result = await runIdpTest(IDP_ID, wrongPassFile);
    expect(result.code, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain("Error: HTTP 401");
    expect(result.stderr).not.toContain("not found");
    expect(result.stdout).not.toContain("Testing IdP");
    expect(jwksFetches).toBe(before);
  }, CASE_BUDGET_MS);
});
