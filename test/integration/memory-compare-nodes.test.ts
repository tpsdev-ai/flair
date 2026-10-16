/**
 * memory-compare-nodes.test.ts — flair#2216, the issue's acceptance, on two
 * REAL Harper nodes.
 *
 * `flair memory compare-nodes` reads each node's Memory ids and newest write
 * time through the admin operations API (the same keyset-paged read and
 * exact-count recheck the memory checkpoint uses) and reports whether the
 * nodes agree. This file drives the built CLI against two ephemeral Harpers:
 *
 *   1. both nodes seeded with the same ids → healthy (exit 0);
 *   2. one node frozen — it accepts no new write while the other does → the
 *      check reports divergent, lagging or unknown, NEVER healthy;
 *   3. a node that cannot be read → unknown, never healthy.
 *
 * It writes to each node's own operations API, so it does not depend on the
 * OSS core's replication transport (which is not implemented; see
 * test/helpers/replicated-nodes.ts). Fixtures use neutral names (node-a/node-b).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarpers, type HarperInstance } from "../helpers/harper-lifecycle.js";
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
    "same ids → healthy; a frozen node → never healthy; an unreadable node → unknown",
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
      const run = async (nodes: string[]) => {
        const child = Bun.spawn(
          ["node", cliPath, "memory", "compare-nodes", ...nodes.flatMap((n) => ["--node", n]), "--fabric-password-file", passwordFile],
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
      const healthy = await run([a.opsURL, b.opsURL]);
      expect(healthy.code, `in-sync pair → healthy\n${healthy.output}`).toBe(0);
      expect(healthy.output).toContain("HEALTHY");

      // 2. Freeze node-b: node-a takes a newer write, node-b does not. node-b may
      //    still be catching up, node-a holds an id no other node has, so the
      //    overall result is divergent, lagging or unknown — never healthy.
      await insert(a, "node-mem-3", new Date().toISOString());
      const frozen = await run([a.opsURL, b.opsURL]);
      expect(frozen.code, `frozen node-b → not healthy\n${frozen.output}`).not.toBe(0);
      expect(frozen.output).not.toContain("HEALTHY");
      expect([2, 3, 4], `frozen node-b → a classified non-healthy result\n${frozen.output}`).toContain(frozen.code);

      // 3. A node that cannot be read (a closed port) → unknown, never healthy.
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("x"); } });
      const deadPort = probe.port;
      await probe.stop(true);
      const unreachable = await run([a.opsURL, `http://127.0.0.1:${deadPort}`]);
      expect(unreachable.code, `unreadable node → unknown\n${unreachable.output}`).toBe(3);
      expect(unreachable.output).toContain("UNKNOWN");
    },
    10 * 60_000,
  );
});
