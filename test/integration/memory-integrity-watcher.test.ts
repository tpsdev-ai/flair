/**
 * memory-integrity-watcher.test.ts — the out-of-store integrity watcher on a
 * REAL ephemeral Harper (flair#2213).
 *
 * Checkpoint a corpus, remove a permanent row BENEATH Flair (an ops-API delete
 * that leaves no deletion record) and restart, then scan: the watcher must alert
 * naming the id. A new deletion record matching a nonempty checkpointed token is attributed. A
 * scan that cannot reach the instance reports UNKNOWN and leaves the checkpoint
 * alone. An equal-size replacement with a different ID is caught
 * by the ID set even though the count is unchanged.
 *
 * Throwaway HOME + data dir, ephemeral ports (never 9925/9926).
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
setDefaultTimeout(150_000);

let harper: HarperInstance;
let home: string;

const checkpointPath = () => join(home, ".flair", "integrity-checkpoint.json");
const adminAuth = () =>
  "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

async function opsInsertMemory(id: string, durability: string): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Memory",
      records: [{ id, agentId: "integrity-e2e", content: `row ${id}`, durability, instanceToken: randomUUID(), createdAt: new Date().toISOString() }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status).toBe(200);
}

async function opsDeleteMemory(id: string): Promise<void> {
  // A raw ops-API delete on the Memory table — it does NOT go through
  // Memory.delete(), so it leaves NO deletion record: a below-Flair removal.
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({ operation: "delete", database: "flair", table: "Memory", ids: [id] }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status).toBe(200);
}

async function restDeleteMemory(id: string): Promise<number> {
  const res = await fetch(`${harper.httpURL}/Memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: adminAuth() },
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

interface CheckResult {
  code: number | null;
  out: string;
  json: any;
}

function runCheck(opts: { opsPort?: string } = {}): CheckResult {
  const r = spawnSync(
    process.execPath,
    [CLI, "integrity", "check", "--json", "--ops-port", opts.opsPort ?? new URL(harper.opsURL).port],
    {
      encoding: "utf-8",
      env: { ...process.env, HOME: home, FLAIR_ADMIN_PASS: harper.admin.password, FLAIR_ADMIN_USER: harper.admin.username },
      timeout: 90_000,
      killSignal: "SIGTERM",
    },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  let json: any = null;
  try {
    json = JSON.parse(out.trim().split("\n").pop() ?? "");
  } catch {
    /* leave null */
  }
  return { code: r.status, out, json };
}

beforeAll(async () => {
  ensureCliBuild();
  home = mkdtempSync(join(tmpdir(), "flair-2213-home-"));
  harper = await startHarper();
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2213 — integrity watcher on a real Harper", () => {
  test("baseline: a first scan establishes the checkpoint (0600, outside the DB)", async () => {
    await opsInsertMemory("itg-perm-1", "permanent");
    await opsInsertMemory("itg-persist-1", "persistent");
    await opsInsertMemory("itg-std-1", "standard");
    const r = runCheck();
    expect(r.code, r.out).toBe(0);
    expect(r.json?.status).toBe("baseline");
    expect(existsSync(checkpointPath())).toBe(true);
    expect(statSync(checkpointPath()).mode & 0o777).toBe(0o600);
    expect(r.json?.counts?.permanent).toBeGreaterThanOrEqual(1);
  }, 150_000);

  test("a permanent row removed beneath Flair, then restart, alerts naming the id", async () => {
    const before = readFileSync(checkpointPath(), "utf-8");
    await opsDeleteMemory("itg-perm-1");

    // Restart the instance (a loss of this class is discovered after a boot).
    const installDir = harper.installDir;
    await stopHarper(harper, { keepInstallDir: true });
    harper = await startHarper({ installDir });
    expect(new URL(harper.opsURL).port).not.toBe("9925");

    const r = runCheck();
    expect(r.code, r.out).toBe(2);
    expect(r.json?.status).toBe("alert");
    const lostIds = (r.json?.losses ?? []).map((l: any) => l.id);
    expect(lostIds).toContain("itg-perm-1");
    // The checkpoint was not advanced while this row was missing.
    expect(readFileSync(checkpointPath(), "utf-8")).toBe(before);
  }, 120_000);

  test("a DELETE with new history matching the checkpointed token is attributed", async () => {
    // Re-baseline, then delete a durable row through Flair's own DELETE route.
    rmSync(checkpointPath(), { force: true });
    await opsInsertMemory("itg-legit-perm", "permanent");
    expect(runCheck().json?.status).toBe("baseline");

    const status = await restDeleteMemory("itg-legit-perm");
    expect([200, 204]).toContain(status);

    const r = runCheck();
    expect(r.code, r.out).toBe(0);
    expect(r.json?.status).toBe("healthy");
    expect((r.json?.losses ?? []).length).toBe(0);
    const attributed = (r.json?.attributedDeletes ?? []).map((d: any) => d.id);
    expect(attributed).toContain("itg-legit-perm");
  }, 150_000);

  test("an unreachable instance reports UNKNOWN and never touches the checkpoint", async () => {
    const before = readFileSync(checkpointPath(), "utf-8");
    const r = runCheck({ opsPort: "1" });
    expect(r.code, r.out).toBe(3);
    expect(r.json?.status).toBe("unknown");
    expect(r.json?.checkpointWritten).toBe(false);
    expect(readFileSync(checkpointPath(), "utf-8")).toBe(before);
  }, 150_000);

  test("an equal-size replacement with a different ID is caught by the ID set", async () => {
    rmSync(checkpointPath(), { force: true });
    await opsInsertMemory("itg-swap-old", "permanent");
    expect(runCheck().json?.status).toBe("baseline");

    // Same permanent COUNT: one durable row removed (beneath Flair), one added.
    await opsDeleteMemory("itg-swap-old");
    await opsInsertMemory("itg-swap-new", "permanent");

    const r = runCheck();
    expect(r.code, r.out).toBe(2);
    expect(r.json?.status).toBe("alert");
    const lostIds = (r.json?.losses ?? []).map((l: any) => l.id);
    expect(lostIds).toContain("itg-swap-old");
  }, 150_000);

  test("recorded delete, same-id recreation, checkpoint, raw delete alerts", async () => {
    rmSync(checkpointPath(), { force: true });
    await opsInsertMemory("itg-recreated", "permanent");
    expect(runCheck().json?.status).toBe("baseline");
    expect([200, 204]).toContain(await restDeleteMemory("itg-recreated"));
    await opsInsertMemory("itg-recreated", "permanent");
    expect(runCheck().json?.status).toBe("healthy");
    await opsDeleteMemory("itg-recreated");
    const r = runCheck();
    expect(r.code, r.out).toBe(2);
    expect(r.json?.losses).toContainEqual({ id: "itg-recreated", tier: "permanent" });
    expect(r.json?.attributedDeletes).toEqual([]);
    expect(r.json?.unexplainedDecrease).toEqual({});
  }, 150_000);
});
