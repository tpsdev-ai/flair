import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { ADMIN_ROLE } from "../../resources/agent-admin.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.ts";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli.ts";
import { buildEd25519Auth } from "../../src/lib/auth-resolve.ts";
import { fetchAndRenderMigrations } from "../../src/commands/doctor.ts";

for (const childLink of [false, true]) {
  test(`Harper boot and authenticated HealthDetail render a refused ${childLink ? ".migrations" : "data-directory"} link`, async () => {
    if (process.env.HARPER_HTTP_URL) throw new Error("This fixture requires a local Harper boot");
    const root = realpathSync(tempDir("flair-2277-harper-"));
    const home = join(root, "home");
    const real = join(root, "real");
    const configured = join(root, "configured");
    mkdirSync(home);
    writeFileSync(join(home, ".flair"), "blocked default");
    mkdirSync(real);
    let installDir: string;
    let target: string;
    let link: string;
    if (childLink) {
      installDir = real;
      target = join(root, "migration-target");
      mkdirSync(target);
      link = join(real, ".migrations");
      symlinkSync(target, link);
    } else {
      installDir = configured;
      target = real;
      link = configured;
      symlinkSync(target, link);
    }
    let harper: HarperInstance | undefined;
    const original = { override: process.env.FLAIR_MIGRATION_DATA_DIR, legacy: process.env.HDB_ROOT };
    process.env.FLAIR_MIGRATION_DATA_DIR = installDir;
    delete process.env.HDB_ROOT;
    try {
      harper = await startHarper({ installDir, homeDir: home });
      const basic = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
      await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
      await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
      const readers = [false, true].map((admin) => {
        const kp = nacl.sign.keyPair();
        const id = `symlink-reader-${admin ? "admin" : "agent"}`;
        const keyPath = join(root, `${id}.key`);
        writeFileSync(keyPath, kp.secretKey.slice(0, 32), { mode: 0o600 });
        return { id, name: id, role: admin ? ADMIN_ROLE : "agent", publicKey: Buffer.from(kp.publicKey).toString("base64"), createdAt: new Date().toISOString(), admin, keyPath };
      });
      const inserted = await fetch(harper.opsURL, {
        method: "POST", headers: { Authorization: basic, "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent",
          records: readers.map(({ keyPath: _keyPath, ...row }) => row) }),
      });
      expect(inserted.status).toBe(200);
      const url = `${harper.httpURL}/HealthDetail`;
      let adminDetail: any;
      const deadline = Date.now() + 30_000;
      do {
        const response = await fetch(url, { headers: { Authorization: basic } });
        expect(response.status).toBe(200);
        adminDetail = await response.json();
        if (adminDetail.migrations?.lastCycleError && (harper.getLog?.() ?? "").includes("[flair-migrations] no writable migration data directory")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      expect(adminDetail.migrations.lastCycleError).toContain("symbolic link");
      expect((harper.getLog?.() ?? "")).toContain("[flair-migrations] no writable migration data directory");
      expect((harper.getLog?.() ?? "")).toContain(link);
      expect((harper.getLog?.() ?? "")).toContain(target);
      for (const reader of readers) {
        const headers = { Authorization: buildEd25519Auth(reader.id, "GET", "/HealthDetail", reader.keyPath) };
        const response = await fetch(url, { headers });
        expect(response.status).toBe(200);
        const detail: any = await response.json();
        expect(detail.caller.isAdmin).toBe(reader.admin);
        expect(detail.migrations.migrations.length).toBeGreaterThan(0);
        if (reader.admin) {
          expect(detail.migrations.lastCycleError).toContain(link);
          expect(detail.migrations.lastCycleError).toContain(target);
          for (const m of detail.migrations.migrations) {
            expect(m.reason).toContain(link);
            expect(m.reason).toContain(target);
            expect(detail.warnings.some((w: any) => w.message.includes(m.reason))).toBe(true);
          }
        } else {
          expect(detail.migrations.lastCycleError).toContain("redacted");
          for (const m of detail.migrations.migrations) expect(m.reason).toContain("redacted");
          expect(detail.warnings.some((w: any) => w.message.includes("redacted"))).toBe(true);
          expect(JSON.stringify(detail)).not.toContain(link);
          expect(JSON.stringify(detail)).not.toContain(target);
        }
        const lines: string[] = [];
        const log = console.log;
        console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
        let issues: number;
        try {
          issues = await fetchAndRenderMigrations(url, {
            Authorization: buildEd25519Auth(reader.id, "GET", "/HealthDetail", reader.keyPath),
          }, "  ");
        } finally { console.log = log; }
        expect(issues!).toBe(detail.migrations.migrations.length + 1);
        expect(lines.find((l) => l.includes("Last migration cycle did not complete:"))).toContain(detail.migrations.lastCycleError);
        for (const m of detail.migrations.migrations) {
          expect(lines.find((l) => l.includes(`${m.id}: failed`))).toContain(m.reason);
        }
      }
    } finally {
      if (harper) await stopHarper(harper);
      if (original.override === undefined) delete process.env.FLAIR_MIGRATION_DATA_DIR;
      else process.env.FLAIR_MIGRATION_DATA_DIR = original.override;
      if (original.legacy === undefined) delete process.env.HDB_ROOT;
      else process.env.HDB_ROOT = original.legacy;
    }
  }, 180_000);
}
