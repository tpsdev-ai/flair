/**
 * import-write-outcome-2900.test.ts — `flair import` counts a row as imported
 * only when its write returned 2xx, against a REAL Harper and the REAL built CLI.
 *
 * One accepted and one refused row (a Soul write the policy refuses and a Memory
 * write with an invalid durability) must give 1 imported / 1 failed, a per-row
 * line naming the id, HTTP status and server error name, and a non-zero exit.
 * An all-accepted file exits zero with the same counts as before the fix.
 *
 * Build prerequisite: `bun run build:cli` (this file exits in beforeAll if
 * dist/cli.js is absent).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeBin } from "../helpers/node-runtime";
import { tempDir } from "../helpers/temp-dir";
import { HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const CREATED_AT = "2026-10-01T00:00:00.000Z";

let harper: HarperInstance;
let running: HarperInstance | undefined;

interface RunResult { code: number | null; stdout: string; stderr: string }

function assertOwnInstance(h: HarperInstance): void {
  for (const u of [new URL(h.httpURL), new URL(h.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) throw new Error("refusing to run: not an instance this test started");
}

/** Run the built CLI with a throwaway HOME and no ambient Flair settings. */
function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const env = { ...ambient, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...extraEnv } as Record<string, string>;
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin({ env }), [CLI, ...args], { env, timeout: 90_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`flair ${args[0]} ended by ${signal}: ${stdout}${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

const adminAuth = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;

interface FakeReply { status: number; body: string }

/** Run `run` against a local REST target that answers each PUT from `reply`. */
async function withFakeRest(
  reply: (path: string) => FakeReply,
  run: (url: string) => Promise<RunResult>,
): Promise<RunResult> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(req.url ?? "");
      const answer = reply(req.url ?? "");
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(seen.length).toBeGreaterThan(0);
  }
}

async function op(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status, `ops ${body.operation}`).toBe(200);
  return res.json();
}

const soulRow = async (id: string): Promise<any> =>
  (await op({ operation: "search_by_id", database: "flair", table: "Soul", ids: [id], get_attributes: ["*"] }))[0];
const memoryRow = async (id: string): Promise<any> =>
  (await op({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] }))[0];

function writeExport(name: string, data: Record<string, unknown>): string {
  const path = join(tempDir("flair-2900-export-"), name);
  writeFileSync(path, JSON.stringify({
    version: 1,
    type: "agent-export",
    exportedAt: CREATED_AT,
    source: harper.httpURL,
    memories: [],
    souls: [],
    grants: [],
    ...data,
  }));
  return path;
}

function importFile(
  exportPath: string,
  home: string,
  extraEnv: Record<string, string> = {},
  restUrl: string = harper.httpURL,
): Promise<RunResult> {
  return runCli([
    "import", exportPath, "--url", restUrl, "--ops-target", harper.opsURL, "--keys-dir", join(home, "keys"),
  ], home, { FLAIR_ADMIN_PASS: harper.admin.password, ...extraEnv });
}

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error("dist/cli.js is missing: run `bun run build:cli` before this file");
  }
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  running = harper;
  assertOwnInstance(harper);
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  if (running) await stopHarper(running);
}, HARPER_STOP_BUDGET_MS);

describe("flair import counts a row as imported only on a 2xx write (#2900)", () => {
  test("Soul: one accepted and one refused row -> 1 imported / 1 failed, named, exit 1", async () => {
    const agent = "import-outcome-soul-a";
    const home = tempDir("flair-2900-home-");
    const acceptedId = `${agent}:identity`;
    const refusedId = `${agent}:refused`;
    const exportPath = writeExport("soul-outcome.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      souls: [
        { id: acceptedId, agentId: agent, key: "identity", value: "accepted soul", durability: "permanent", createdAt: CREATED_AT },
        { id: refusedId, key: "refused", value: "a soul write the policy refuses", durability: "permanent", createdAt: CREATED_AT },
      ],
    });

    const result = await importFile(exportPath, home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(`Soul ${refusedId} failed: HTTP 403 soul_owner_required`);
    expect(result.stdout).toMatch(/Souls\s+1\/2/);
    expect(result.stdout).toMatch(/Failed\s+1/);
    expect(await soulRow(acceptedId)).toMatchObject({ agentId: agent, value: "accepted soul" });
    expect(await soulRow(refusedId)).toBeUndefined();
  }, 300_000);

  test("Memory: one accepted and one refused row -> 1 imported / 1 failed, named, exit 1", async () => {
    const agent = "import-outcome-memory-a";
    const home = tempDir("flair-2900-home-");
    const acceptedId = `${agent}:mem-ok`;
    const refusedId = `${agent}:mem-refused`;
    const exportPath = writeExport("memory-outcome.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      memories: [
        { id: acceptedId, agentId: agent, content: "an accepted memory", visibility: "private", durability: "standard", createdAt: CREATED_AT },
        { id: refusedId, agentId: agent, content: "a memory write the policy refuses", visibility: "private", durability: "bogus", createdAt: CREATED_AT },
      ],
    });

    const result = await importFile(exportPath, home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(`Memory ${refusedId} failed: HTTP 400 invalid_durability`);
    expect(result.stdout).toMatch(/Memories\s+1\/2/);
    expect(result.stdout).toMatch(/Failed\s+1/);
    expect(await memoryRow(acceptedId)).toMatchObject({ agentId: agent, content: "an accepted memory" });
    expect(await memoryRow(refusedId)).toBeUndefined();
  }, 300_000);

  test("an unknown write outcome is reported and exits 3", async () => {
    const agent = "import-outcome-unknown-a";
    const home = tempDir("flair-2900-home-");
    const soulId = `${agent}:identity`;
    const exportPath = writeExport("unknown-outcome.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      souls: [{ id: soulId, agentId: agent, key: "identity", value: "a soul write with no response", durability: "permanent", createdAt: CREATED_AT }],
    });

    // A REST target that accepts the PUT and never answers: the write may or
    // may not have taken effect, which is the unknown outcome, not a failure.
    const stalls = createServer((req) => { req.resume(); });
    await new Promise<void>((resolve) => stalls.listen(0, "127.0.0.1", () => resolve()));
    const address = stalls.address() as AddressInfo;
    let result: RunResult;
    try {
      result = await importFile(exportPath, home, { FLAIR_REQUEST_TIMEOUT_MS: "1000" }, `http://127.0.0.1:${address.port}`);
    } finally {
      stalls.closeAllConnections();
      await new Promise<void>((resolve) => stalls.close(() => resolve()));
    }

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(3);
    expect(result.stderr).toContain(`Soul ${soulId} unknown:`);
    expect(result.stderr).toContain("may or may not have taken effect");
    expect(result.stdout).toMatch(/Souls\s+0\/1/);
    expect(result.stdout).toMatch(/Unknown\s+1/);
    expect(result.stdout).not.toMatch(/Failed/);
  }, 300_000);

  test("an all-accepted file exits 0 and keeps the existing counts", async () => {
    const agent = "import-outcome-accepted-a";
    const home = tempDir("flair-2900-home-");
    const soulId = `${agent}:identity`;
    const memId = `${agent}:mem-ok`;
    const exportPath = writeExport("all-accepted.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      souls: [{ id: soulId, agentId: agent, key: "identity", value: "accepted soul", durability: "permanent", createdAt: CREATED_AT }],
      memories: [{ id: memId, agentId: agent, content: "an accepted memory", visibility: "private", durability: "standard", createdAt: CREATED_AT }],
    });

    const result = await importFile(exportPath, home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/Souls\s+1\/1/);
    expect(result.stdout).toMatch(/Memories\s+1\/1/);
    expect(result.stdout).not.toMatch(/Failed/);
    expect(result.stderr).toBe("");
    expect(await soulRow(soulId)).toMatchObject({ agentId: agent, value: "accepted soul" });
    expect(await memoryRow(memId)).toMatchObject({ agentId: agent, content: "an accepted memory" });
  }, 300_000);

  test("with FLAIR_DEBUG set, a refusal body echoing the row value is not printed", async () => {
    const agent = "import-outcome-debug-a";
    const home = tempDir("flair-2900-home-");
    const soulId = `${agent}:refused-debug`;
    const rowValue = "row-value-debug-xyz";
    const credentialShape = "sk_live_debug123456";
    const exportPath = writeExport("debug-refusal.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      souls: [{ id: soulId, agentId: agent, key: "refused-debug", value: rowValue, durability: "permanent", createdAt: CREATED_AT }],
    });

    const result = await withFakeRest(
      () => ({ status: 403, body: JSON.stringify({ error: `refused for ${rowValue} with key ${credentialShape}` }) }),
      (url) => importFile(exportPath, home, { FLAIR_DEBUG: "1" }, url),
    );

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(`Soul ${soulId} failed: HTTP 403`);
    // The debug line still reports the status; only its body is withheld.
    expect(result.stderr).toContain(`[flair] PUT /Soul/`);
    expect(result.stderr).toContain("answered HTTP 403");
    expect(result.stdout + result.stderr).not.toContain(rowValue);
    expect(result.stdout + result.stderr).not.toContain(credentialShape);
  }, 300_000);

  test("an unrecognised refusal body is not displayed; a recognised name still is", async () => {
    const agent = "import-outcome-raw-a";
    const home = tempDir("flair-2900-home-");
    const soulId = `${agent}:refused-raw`;
    const memId = `${agent}:mem-named`;
    const rowValue = "row-value-xyz";
    const credentialShape = "sk_live_abcdef123456";
    const exportPath = writeExport("raw-refusal.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      souls: [{ id: soulId, agentId: agent, key: "refused-raw", value: "a soul write", durability: "permanent", createdAt: CREATED_AT }],
      memories: [{ id: memId, agentId: agent, content: "a memory write", visibility: "private", durability: "standard", createdAt: CREATED_AT }],
    });

    const result = await withFakeRest(
      (path) => path.includes("/Soul/")
        ? { status: 403, body: JSON.stringify({ error: `refused for ${rowValue} with key ${credentialShape}` }) }
        : { status: 400, body: JSON.stringify({ error: "invalid_durability" }) },
      (url) => importFile(exportPath, home, {}, url),
    );

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(`Soul ${soulId} failed: HTTP 403`);
    expect(result.stderr).toContain("Memory " + memId + " failed: HTTP 400 invalid_durability");
    expect(result.stdout + result.stderr).not.toContain(rowValue);
    expect(result.stdout + result.stderr).not.toContain(credentialShape);
  }, 300_000);

  test("a refusal with an empty body reports the status and no name", async () => {
    const agent = "import-outcome-empty-a";
    const home = tempDir("flair-2900-home-");
    const soulId = `${agent}:refused-empty`;
    const exportPath = writeExport("empty-refusal.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      souls: [{ id: soulId, agentId: agent, key: "refused-empty", value: "a soul write", durability: "permanent", createdAt: CREATED_AT }],
    });

    const result = await withFakeRest(
      () => ({ status: 403, body: "" }),
      (url) => importFile(exportPath, home, {}, url),
    );

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`Soul ${soulId} failed: HTTP 403$`, "m"));
  }, 300_000);

  test("a scope-field refusal name on a 500 is a failed row, exit 1", async () => {
    const agent = "import-outcome-500-a";
    const home = tempDir("flair-2900-home-");
    const soulId = `${agent}:refused-500`;
    const exportPath = writeExport("scope-500.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      souls: [{ id: soulId, agentId: agent, key: "refused-500", value: "a scoped soul write", scopeTag: "agent:other", durability: "permanent", createdAt: CREATED_AT }],
    });

    const result = await withFakeRest(
      () => ({ status: 500, body: JSON.stringify({ error: "soul_scope_fields_not_writable" }) }),
      (url) => importFile(exportPath, home, {}, url),
    );

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(`Soul ${soulId} failed: HTTP 500 soul_scope_fields_not_writable`);
    expect(result.stdout).not.toMatch(/refused/);
  }, 300_000);

  test("a scope-field refusal name on a 403 for a row without scope fields is a failed row, exit 1", async () => {
    const agent = "import-outcome-403-plain-a";
    const home = tempDir("flair-2900-home-");
    const soulId = `${agent}:refused-plain`;
    const exportPath = writeExport("scope-403-plain.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      souls: [{ id: soulId, agentId: agent, key: "refused-plain", value: "a plain soul write", durability: "permanent", createdAt: CREATED_AT }],
    });

    const result = await withFakeRest(
      () => ({ status: 403, body: JSON.stringify({ error: "soul_scope_fields_not_writable" }) }),
      (url) => importFile(exportPath, home, {}, url),
    );

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(`Soul ${soulId} failed: HTTP 403 soul_scope_fields_not_writable`);
    expect(result.stdout).not.toMatch(/refused/);
  }, 300_000);

  test("the real scoped-row refusal still skips the row", async () => {
    const agent = "import-outcome-scoped-a";
    const home = tempDir("flair-2900-home-");
    const soulId = `${agent}:scoped`;
    const exportPath = writeExport("scoped-skip.json", {
      agent: { id: agent, name: agent, role: "agent", createdAt: CREATED_AT },
      souls: [{ id: soulId, agentId: agent, key: "scoped", value: "a scoped soul write", scopeTag: "agent:other", durability: "permanent", createdAt: CREATED_AT }],
    });

    const result = await importFile(exportPath, home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Soul ${soulId} refused: soul_scope_fields_not_writable`);
    expect(result.stdout).toMatch(/Souls\s+0\/1/);
    expect(result.stdout).not.toMatch(/Failed/);
    expect(result.stderr).toBe("");
    expect(await soulRow(soulId)).toBeUndefined();
  }, 300_000);
});