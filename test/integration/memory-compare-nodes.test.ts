/**
 * memory-compare-nodes.test.ts — flair#2216, the issue's acceptance, on two
 * REAL Harper nodes.
 *
 * The built CLI compares observed Memory ids and stored timestamps through
 * the admin operations API on two ephemeral Harpers: equal ids, a keyset page
 * boundary, an additional Memory POST on node-a, and an unreadable node.
 * Node-b receives no additional write.
 *
 * Checks the Memory POST's updatedAt stamp with caller-supplied createdAt.
 * Timestamp comparisons classify stored values, not actual write order.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarpers, type HarperInstance } from "../helpers/harper-lifecycle.js";
import { readNode } from "../../src/memory-node-compare.js";
import { assertOwnedInstance } from "../helpers/replicated-nodes.js";

const cliPath = resolve("dist/cli.js");
const OLD = "2020-01-01T00:00:00.000Z";
const CLI_TIMEOUT_MS = 60_000;

const instances: HarperInstance[] = [];
const tempDirs: string[] = [];

afterAll(async () => {
  await stopHarpers(instances).catch(() => { /* best effort */ });
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}, HARPER_STOP_BUDGET_MS);

async function insert(inst: HarperInstance, id: string, createdAt: string): Promise<void> {
  const res = await fetch(inst.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${inst.admin.username}:${inst.admin.password}`).toString("base64")}`,
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Memory",
      records: [{ id, agentId: "compare-agent", content: "fixture content", createdAt, durability: "standard" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`insert ${id} → HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
}

describe("flair#2216 — compare Memory ids across two real nodes", () => {
  test(
    "same ids → healthy; a Memory POST → divergent with a lagging peer; unreadable → unknown",
    async () => {
      const a = await startHarper();
      instances.push(a);
      assertOwnedInstance(a, "node-a");
      const b = await startHarper();
      instances.push(b);
      assertOwnedInstance(b, "node-b");

      const dir = mkdtempSync(join(tmpdir(), "flair-test-2216-"));
      tempDirs.push(dir);
      const passwordFile = join(dir, "password");
      writeFileSync(passwordFile, a.admin.password, { mode: 0o600 });

      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !/^(FLAIR_|FABRIC_|HARPER_|HDB_)/.test(key)) env[key] = value;
      }
      env.HOME = dir;
      env.USERPROFILE = dir;
      env.FABRIC_USER = a.admin.username;

      /** Run the built CLI against the named nodes; returns exit code and combined output. */
      const run = async (nodes: string[], json = false) => {
        const child = Bun.spawn(
          ["node", cliPath, "memory", "compare-nodes", ...nodes.flatMap((n) => ["--node", n]), "--fabric-password-file", passwordFile, ...(json ? ["--json"] : [])],
          { env, stdout: "pipe", stderr: "pipe", timeout: CLI_TIMEOUT_MS },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { code, output: stdout + stderr };
      };

      // 1. Seed the same two ids on BOTH nodes → in sync.
      await insert(a, "node-mem-1", OLD);
      await insert(a, "node-mem-2", OLD);
      await insert(b, "node-mem-1", OLD);
      await insert(b, "node-mem-2", OLD);
      const paged = await readNode(a.opsURL, { pageSize: 1, user: a.admin.username, password: a.admin.password });
      expect(paged.kind).toBe("read");
      if (paged.kind === "read") expect(paged.rows.map((row) => row.id)).toEqual(["node-mem-1", "node-mem-2"]);
      const healthy = await run([a.opsURL, b.opsURL]);
      expect(healthy.code, `in-sync pair → healthy\n${healthy.output}`).toBe(0);
      expect(healthy.output).toContain("HEALTHY");

      // 2. Write through Flair's Memory resource; node-b receives no write.
      const written = await fetch(`${a.httpURL}/Memory`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${a.admin.username}:${a.admin.password}`).toString("base64")}`,
        },
        body: JSON.stringify({
          id: "node-mem-3", agentId: "compare-agent", content: "Memory resource fixture",
          createdAt: OLD, updatedAt: OLD, durability: "standard",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      expect(written.ok, await written.text()).toBe(true);
      const storedResponse = await fetch(a.opsURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${a.admin.username}:${a.admin.password}`).toString("base64")}`,
        },
        body: JSON.stringify({ operation: "sql", sql: "SELECT createdAt, updatedAt FROM flair.Memory WHERE id = 'node-mem-3'" }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(storedResponse.ok).toBe(true);
      const stored = await storedResponse.json() as { createdAt: string; updatedAt: string }[];
      expect(stored).toHaveLength(1);
      expect(stored[0].createdAt).toBe(OLD);
      expect(Date.parse(stored[0].updatedAt)).toBeGreaterThan(Date.parse(OLD));
      const different = await run([a.opsURL, b.opsURL], true);
      expect(different.code, different.output).toBe(2);
      const comparison = JSON.parse(different.output) as {
        verdict: string;
        nodes: { node: string; verdict: string; newestWrite: string | null; missing: { sample: string[] } }[];
      };
      expect(comparison.verdict).toBe("divergent");
      // newestWrite is the node's latest stored timestamp across ALL its rows; a server-side
      // write (the embedding backfill) can move a row's updatedAt after the read above, so
      // the row's read time is a lower bound, not an equality.
      const newestWrite = comparison.nodes.find((node) => node.node === a.opsURL)?.newestWrite;
      expect(newestWrite).not.toBeNull();
      expect(Date.parse(newestWrite!)).toBeGreaterThanOrEqual(Date.parse(stored[0].updatedAt));
      expect(comparison.nodes.find((node) => node.node === b.opsURL)).toMatchObject({
        verdict: "lagging", missing: { sample: ["node-mem-3"] },
      });

      // 3. A node that cannot be read (a closed port) → unknown, never healthy.
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("x"); } });
      const deadPort = probe.port;
      await probe.stop(true);
      const unreachable = await run([a.opsURL, `http://127.0.0.1:${deadPort}`]);
      expect(unreachable.code, `unreadable node → unknown\n${unreachable.output}`).toBe(3);
      expect(unreachable.output).toContain("UNKNOWN");
      expect(unreachable.output).toContain("(UNAVAILABLE id(s), maximum timestamp UNAVAILABLE)");
      expect(unreachable.output.match(/missing: UNAVAILABLE/g)).toHaveLength(2);
      expect(unreachable.output.match(/extra: UNAVAILABLE/g)).toHaveLength(2);
      const unavailableJson = await run([a.opsURL, `http://127.0.0.1:${deadPort}`], true);
      expect(unavailableJson.code, unavailableJson.output).toBe(3);
      expect(JSON.parse(unavailableJson.output).nodes).toMatchObject([
        { rowCount: 3, missing: "UNAVAILABLE", extra: "UNAVAILABLE" },
        { rowCount: "UNAVAILABLE", newestWrite: "UNAVAILABLE", missing: "UNAVAILABLE", extra: "UNAVAILABLE" },
      ]);
    },
    10 * 60_000,
  );
});
