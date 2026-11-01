/**
 * soul-scope-fields-replay-1540.test.ts — the replay writers against a REAL
 * Harper and the REAL built CLI (flair#1540).
 *
 * A stored Soul row that carries `tags` or `scopeTag` is refused, not stripped,
 * when a writer sends it back. Two writers replay a stored row whole:
 *
 *   - `flair restore` over a real backup archive whose Soul rows were edited to
 *     carry the fields: the refused rows are reported with their ids and the
 *     refusal's name, the rest of the archive still restores, and restore exits
 *     non-zero. An `adk:`-tagged row in the same archive shows the handling a
 *     refused Soul row already got before this change: reported by id and HTTP
 *     status, nothing written.
 *   - `flair import` over a real agent-export file carrying the same row: the
 *     refused row is named with its id and the refusal's name, the ordinary
 *     Soul row still lands, and import exits zero.
 *
 * Real files: the archive and export are files on disk, under a throwaway HOME.
 * Build prerequisite: `bun run build && bun run build:cli` (this file exits in
 * beforeAll if dist/cli.js is absent).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import nacl from "tweetnacl";
import { nodeBin } from "../helpers/node-runtime";
import { tempDir } from "../helpers/temp-dir";
import { HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT = "replay-agent";
const IMPORT_AGENT = "replay-import-agent";
const CREATED_AT = "2026-10-01T00:00:00.000Z";
const SOUL_ID = `${AGENT}:identity`;
const SCOPE_SOUL_ID = `${AGENT}:scoped`;
const ADK_SOUL_ID = `${AGENT}:adk`;
const REFUSAL = "soul_scope_fields_not_writable";

let harper: HarperInstance;
let running: HarperInstance | undefined;
let passFile: string;

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

async function operatorPut(path: string, body: unknown): Promise<number> {
  const res = await fetch(harper.httpURL + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  await res.text();
  return res.status;
}

const soulRow = async (id: string): Promise<any> =>
  (await op({ operation: "search_by_id", database: "flair", table: "Soul", ids: [id], get_attributes: ["*"] }))[0];

/** A real `flair backup` of `AGENT`; returns the archive path. */
async function backup(home: string, name: string): Promise<string> {
  const output = join(tempDir("flair-1540-real-archive-"), name);
  const result = await runCli([
    "backup", "--url", harper.httpURL, "--ops-target", harper.opsURL, "--admin-pass-file", passFile,
    "--agents", AGENT, "--output", output,
  ], home);
  expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
  expect(existsSync(`${output}.sha256`)).toBe(true);
  return output;
}

/** Rewrite an archive and publish the digest sidecar its new bytes hash to. */
function republish(archive: string, rows: any[]): void {
  writeFileSync(archive, JSON.stringify(rows));
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`);
}

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error("dist/cli.js is missing: run `bun run build:cli` before this file; `bun run build` alone does not build the CLI");
  }
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  running = harper;
  assertOwnInstance(harper);
  const secrets = tempDir("flair-1540-real-secrets-");
  passFile = join(secrets, "admin-pass");
  writeFileSync(passFile, `${harper.admin.password}\n`, { mode: 0o600 });

  await op({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{ id: AGENT, name: AGENT, role: "agent", publicKey: Buffer.from(nacl.sign.keyPair().publicKey).toString("base64"), createdAt: CREATED_AT }],
  });
  expect(await operatorPut(`/Soul/${encodeURIComponent(SOUL_ID)}`, {
    id: SOUL_ID, agentId: AGENT, key: "identity", value: "The row the archive brings back", durability: "permanent", createdAt: CREATED_AT,
  })).toBeLessThan(300);
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  if (running) await stopHarper(running);
}, HARPER_STOP_BUDGET_MS);

describe("flair restore refuses an archived Soul row that carries scope fields (flair#1540)", () => {
  test("the row is refused by name and out of the restore; an adk-tagged row gets today's handling; the rest of the archive restores", async () => {
    const home = tempDir("flair-1540-real-home-");
    const archive = await backup(home, "scoped-soul.json");
    const parsed = JSON.parse(readFileSync(archive, "utf8"));
    expect(parsed.souls.map((s: any) => s.id)).toEqual([SOUL_ID]);

    republish(archive, {
      ...parsed,
      souls: [
        ...parsed.souls,
        { id: SCOPE_SOUL_ID, agentId: AGENT, key: "scoped", value: "Content with a per-user scope", durability: "permanent", createdAt: CREATED_AT, scopeTag: "team:alpha" },
        { id: ADK_SOUL_ID, agentId: AGENT, key: "adk", value: "Content with the vendor tag", durability: "permanent", createdAt: CREATED_AT, tags: ["adk:app:alice"] },
      ],
    });

    // The ordinary row changed on the target, so the restore has to write it.
    await op({ operation: "upsert", database: "flair", table: "Soul", records: [{ id: SOUL_ID, value: "Changed since the backup" }] });
    expect((await soulRow(SOUL_ID)).value).toBe("Changed since the backup");

    const restored = await runCli(["restore", archive, "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });
    expect(restored.code).toBe(1);
    expect(restored.stdout).not.toContain("Restore complete");
    expect(restored.stderr.trimEnd().split("\n").sort()).toEqual([
      `Error: Soul ${SCOPE_SOUL_ID} (agent ${AGENT}): PUT failed (HTTP 403): ${REFUSAL}`,
      `Error: Soul ${ADK_SOUL_ID} (agent ${AGENT}): PUT failed (HTTP 403)`,
      `Error: Soul ${SCOPE_SOUL_ID} (agent ${AGENT}): GET failed (HTTP 404): verification failed`,
      `Error: Soul ${ADK_SOUL_ID} (agent ${AGENT}): GET failed (HTTP 404): verification failed`,
    ].sort());

    // The rest of the archive landed; neither refused row exists.
    expect(await soulRow(SOUL_ID)).toMatchObject({ agentId: AGENT, key: "identity", value: "The row the archive brings back" });
    expect(await soulRow(SCOPE_SOUL_ID)).toBeUndefined();
    expect(await soulRow(ADK_SOUL_ID)).toBeUndefined();
  }, 300_000);
});

describe("flair import refuses an exported Soul row that carries scope fields (flair#1540)", () => {
  test("the row is named with the refusal in the output and not written; an ordinary Soul row still lands", async () => {
    const home = tempDir("flair-1540-real-home-");
    const exportPath = join(tempDir("flair-1540-real-export-"), "agent-export.json");
    const scopedId = `${IMPORT_AGENT}:scoped`;
    const plainId = `${IMPORT_AGENT}:identity`;
    writeFileSync(exportPath, JSON.stringify({
      version: 1,
      type: "agent-export",
      exportedAt: CREATED_AT,
      source: harper.httpURL,
      agent: { id: IMPORT_AGENT, name: IMPORT_AGENT, role: "agent", createdAt: CREATED_AT },
      memories: [],
      souls: [
        { id: scopedId, agentId: IMPORT_AGENT, key: "scoped", value: "Content with a per-user scope", durability: "permanent", createdAt: CREATED_AT, scopeTag: "team:alpha" },
        { id: plainId, agentId: IMPORT_AGENT, key: "identity", value: "The row the export brings back", durability: "permanent", createdAt: CREATED_AT },
      ],
      grants: [],
    }));

    const imported = await runCli([
      "import", exportPath, "--url", harper.httpURL, "--ops-target", harper.opsURL, "--keys-dir", join(home, "keys"),
    ], home, { FLAIR_ADMIN_PASS: harper.admin.password });
    expect(imported.code, `${imported.stdout}${imported.stderr}`).toBe(0);
    expect(imported.stdout).toContain(`Soul ${scopedId} refused: ${REFUSAL}`);
    expect(imported.stdout).toContain(`Agent '${IMPORT_AGENT}' imported`);

    expect(await soulRow(plainId)).toMatchObject({ agentId: IMPORT_AGENT, value: "The row the export brings back" });
    expect(await soulRow(scopedId)).toBeUndefined();
  }, 300_000);
});
