import { beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { markSkillSeedPending, reconcilePendingSkillSeed, skillSeedPendingPath } from "../../src/lib/skill-seed-pending.js";
import type { SkillSeedOutcome } from "../../src/lib/skill-seed.js";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

const seeded: SkillSeedOutcome = {
  kind: "ok", action: "create", skillId: "skill:using-flair",
  assignmentId: "org-skill:using-flair", message: "seeded",
};
const refused: SkillSeedOutcome = { kind: "refused", error: "test", message: "refused" };

describe("local --skip-start seed handoff", () => {
  // Build dist/cli.js AT MOST ONCE per lane (flair#1807) — see
  // test/helpers/build-cli-once.ts. Its own hook, budgeted above the helper's
  // 90 s build limit, so a genuine build hang is named here instead of a bare
  // 5 s per-case kill (the cases below must not carry the build's cost).
  beforeAll(() => {
    ensureCliBuild();
  }, 120_000);

  it("runs on the next start, clears only after success, and does not run again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-skill-pending-"));
    try {
      let calls = 0;
      const seed = async () => { calls++; return seeded; };
      expect(await reconcilePendingSkillSeed(dir, seed)).toBeNull();
      markSkillSeedPending(dir);
      expect(existsSync(skillSeedPendingPath(dir))).toBe(true);
      expect(await reconcilePendingSkillSeed(dir, seed)).toEqual(seeded);
      expect(existsSync(skillSeedPendingPath(dir))).toBe(false);
      expect(await reconcilePendingSkillSeed(dir, seed)).toBeNull();
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains the marker on refusal and on a thrown credential error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-skill-pending-"));
    try {
      markSkillSeedPending(dir);
      expect(await reconcilePendingSkillSeed(dir, async () => refused)).toEqual(refused);
      expect(existsSync(skillSeedPendingPath(dir))).toBe(true);
      await expect(reconcilePendingSkillSeed(dir, async () => { throw new Error("no credential"); })).rejects.toThrow("no credential");
      expect(existsSync(skillSeedPendingPath(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leave an unreachable pending marker for a custom data directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "fsc-"));
    const dataDir = join(home, "custom data");
    const root = resolve(import.meta.dirname, "..", "..");
    try {
      const argv = ["init", "--skip-start", "--no-mcp", "--skip-soul",
        "--data-dir", dataDir, "--port", "44473", "--admin-pass", "test-only-password"];
      const script = `
        import net from "node:net";
        import { EventEmitter } from "node:events";
        import { syncBuiltinESMExports } from "node:module";
        net.createConnection = () => {
          const socket = new EventEmitter();
          socket.setTimeout = () => {};
          socket.destroy = () => {};
          queueMicrotask(() => socket.emit("error", Object.assign(new Error("fixture stopped"), { code: "ECONNREFUSED" })));
          return socket;
        };
        syncBuiltinESMExports();
        globalThis.fetch = async () => { throw new Error("fixture stopped"); };
        const { program, setOccupiedListenerLookupForTests } = await import(${JSON.stringify(pathToFileURL(join(root, "dist", "cli.js")).href)});
        setOccupiedListenerLookupForTests({ pids: () => [], rootPath: () => ({ rootPath: null, environReadable: false }) });
        await program.parseAsync(${JSON.stringify(argv)}, { from: "user" });
      `;
      const run = spawnSync("node", ["--input-type=module", "-e", script], {
        cwd: root, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, HOME: home, FLAIR_TARGET: "", FLAIR_OPS_TARGET: "" },
      });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain("using-flair skill: not seeded");
      expect(run.stdout).not.toContain(`flair init --data-dir '${dataDir}'`);
      expect(existsSync(skillSeedPendingPath(dataDir))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
