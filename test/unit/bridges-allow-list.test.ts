import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  allow,
  revoke,
  list,
  isAllowed,
  verifyAllow,
  digestPackage,
} from "../../src/bridges/runtime/allow-list";
import type { DiscoveredBridge } from "../../src/bridges/types";

function sandbox(): {
  allowPath: string;
  makePackage: (name: string, pkgJson?: Record<string, unknown>) => string;
  root: string;
  cleanup: () => void;
} {
  const dir = realpathSync(tmpdir());
  const root = join(dir, `flair-allow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return {
    allowPath: join(root, "bridges-allowed.json"),
    root,
    makePackage: (name, pkgJson = {}) => {
      const pkgDir = join(root, `pkg-${name}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: `flair-bridge-${name}`, version: "1.0.0", ...pkgJson }, null, 2),
      );
      return pkgDir;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function discovered(name: string, path: string): DiscoveredBridge {
  return { name, kind: "api", source: "npm-package", path };
}

describe("allow-list: basic CRUD", () => {
  let sb: ReturnType<typeof sandbox>;
  beforeEach(() => { sb = sandbox(); });
  afterEach(() => sb.cleanup());

  test("isAllowed returns false for an empty list (file absent)", async () => {
    expect(await isAllowed("anything", { path: sb.allowPath })).toBe(false);
  });

  test("allow creates the file and records a full entry with location + digest", async () => {
    const pkg = sb.makePackage("mem0");
    const result = await allow("mem0", pkg, { path: sb.allowPath });
    expect(result.alreadyAllowed).toBe(false);
    expect(existsSync(sb.allowPath)).toBe(true);

    const saved = JSON.parse(readFileSync(sb.allowPath, "utf-8"));
    const entry = saved.allowed[0];
    expect(entry.name).toBe("mem0");
    expect(entry.allowedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.packageDir).toBe(realpathSync(pkg));
    expect(entry.packageJsonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.version).toBe("1.0.0");
  });

  test("allow is idempotent when location+digest unchanged", async () => {
    const pkg = sb.makePackage("mem0");
    await allow("mem0", pkg, { path: sb.allowPath });
    const second = await allow("mem0", pkg, { path: sb.allowPath });
    expect(second.alreadyAllowed).toBe(true);
    const entries = await list({ path: sb.allowPath });
    expect(entries).toHaveLength(1);
  });

  test("allow re-runs cleanly on legitimate updates (new digest replaces old)", async () => {
    const pkg = sb.makePackage("mem0");
    await allow("mem0", pkg, { path: sb.allowPath });
    // Simulate a package upgrade that rewrites package.json
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "flair-bridge-mem0", version: "1.1.0" }, null, 2));
    const result = await allow("mem0", pkg, { path: sb.allowPath });
    expect(result.alreadyAllowed).toBe(false);
    expect(result.updated).toBe(true);
    const entries = await list({ path: sb.allowPath });
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe("1.1.0");
  });

  test("revoke removes the entry and reports wasAllowed", async () => {
    const pkg = sb.makePackage("mem0");
    await allow("mem0", pkg, { path: sb.allowPath });
    const result = await revoke("mem0", { path: sb.allowPath });
    expect(result.wasAllowed).toBe(true);
    expect(await isAllowed("mem0", { path: sb.allowPath })).toBe(false);
  });

  test("revoke on a missing entry reports wasAllowed=false, no-op", async () => {
    const result = await revoke("never-allowed", { path: sb.allowPath });
    expect(result.wasAllowed).toBe(false);
  });

  test("list returns entries sorted by name (deterministic file contents)", async () => {
    await allow("zeta", sb.makePackage("zeta"), { path: sb.allowPath });
    await allow("alpha", sb.makePackage("alpha"), { path: sb.allowPath });
    await allow("middle", sb.makePackage("middle"), { path: sb.allowPath });
    const entries = await list({ path: sb.allowPath });
    expect(entries.map((e) => e.name)).toEqual(["alpha", "middle", "zeta"]);
  });

  test("malformed JSON file is tolerated as an empty list", async () => {
    writeFileSync(sb.allowPath, "{definitely not valid json");
    expect(await isAllowed("anything", { path: sb.allowPath })).toBe(false);
    await allow("mem0", sb.makePackage("mem0"), { path: sb.allowPath });
    expect(await isAllowed("mem0", { path: sb.allowPath })).toBe(true);
  });

  test("entries missing required fields are filtered on read (legacy migration)", async () => {
    const pkg = sb.makePackage("ok");
    const digest = createHash("sha256").update(readFileSync(join(pkg, "package.json"))).digest("hex");
    writeFileSync(sb.allowPath, JSON.stringify({
      allowed: [
        { name: "ok", allowedAt: new Date().toISOString(), packageDir: realpathSync(pkg), packageJsonSha256: digest },
        // Legacy name-only row from 0.6.0/0.6.1 — dropped on read.
        { name: "legacy", allowedAt: new Date().toISOString() },
        { name: "bad" },
        { foo: "missing name" },
      ],
    }));
    const entries = await list({ path: sb.allowPath });
    expect(entries.map((e) => e.name)).toEqual(["ok"]);
  });

  test("writes are atomic (no leftover .tmp on success)", async () => {
    await allow("mem0", sb.makePackage("mem0"), { path: sb.allowPath });
    const siblings = require("node:fs").readdirSync(require("node:path").dirname(sb.allowPath));
    expect(siblings.filter((f: string) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("digestPackage: content hashing", () => {
  let sb: ReturnType<typeof sandbox>;
  beforeEach(() => { sb = sandbox(); });
  afterEach(() => sb.cleanup());

  test("returns stable sha + canonical path + version", async () => {
    const pkg = sb.makePackage("mem0", { version: "2.5.0" });
    const { canonicalDir, sha256, version } = await digestPackage(pkg);
    expect(canonicalDir).toBe(realpathSync(pkg));
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(version).toBe("2.5.0");
  });

  test("sha changes when package.json content changes", async () => {
    const pkg = sb.makePackage("mem0");
    const first = await digestPackage(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "flair-bridge-mem0", version: "9.9.9" }, null, 2));
    const second = await digestPackage(pkg);
    expect(second.sha256).not.toBe(first.sha256);
  });

  test("throws when package.json is missing", async () => {
    let thrown: any = null;
    try { await digestPackage(join(sb.root, "does-not-exist")); } catch (e) { thrown = e; }
    expect(thrown).not.toBeNull();
  });
});

describe("verifyAllow: load-time squatting defense", () => {
  let sb: ReturnType<typeof sandbox>;
  beforeEach(() => { sb = sandbox(); });
  afterEach(() => sb.cleanup());

  test("ok when name + canonical path + digest all match the record", async () => {
    const pkg = sb.makePackage("mem0");
    await allow("mem0", pkg, { path: sb.allowPath });
    const v = await verifyAllow(discovered("mem0", pkg), { path: sb.allowPath });
    expect(v.ok).toBe(true);
  });

  test("not-allowed when name has no entry", async () => {
    const pkg = sb.makePackage("mem0");
    const v = await verifyAllow(discovered("mem0", pkg), { path: sb.allowPath });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("not-allowed");
  });

  test("path-mismatch when a squatter at a different directory uses the allowed name", async () => {
    const real = sb.makePackage("mem0");
    const squat = sb.makePackage("mem0"); // different dir, same short name
    await allow("mem0", real, { path: sb.allowPath });
    const v = await verifyAllow(discovered("mem0", squat), { path: sb.allowPath });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("path-mismatch");
      if (v.reason === "path-mismatch") {
        expect(v.entry.packageDir).toBe(realpathSync(real));
        expect(v.observedPath).toBe(realpathSync(squat));
      }
    }
  });

  test("digest-mismatch when the package.json at the approved location changes after approval", async () => {
    const pkg = sb.makePackage("mem0");
    await allow("mem0", pkg, { path: sb.allowPath });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "flair-bridge-mem0", version: "9.9.9", backdoor: true }, null, 2));
    const v = await verifyAllow(discovered("mem0", pkg), { path: sb.allowPath });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("digest-mismatch");
  });

  test("package-missing when the approved directory no longer exists on disk", async () => {
    const pkg = sb.makePackage("mem0");
    await allow("mem0", pkg, { path: sb.allowPath });
    rmSync(pkg, { recursive: true, force: true });
    const v = await verifyAllow(discovered("mem0", pkg), { path: sb.allowPath });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("package-missing");
  });

  test("entry-incomplete when someone hand-edits the file to drop the digest fields", async () => {
    const pkg = sb.makePackage("mem0");
    // Write a synthetic row that claims to be an entry but with only name+allowedAt.
    // read() filters these out, so we bypass it by writing a structurally complete
    // row whose packageDir + sha are the empty string — verifyAllow must still refuse.
    writeFileSync(sb.allowPath, JSON.stringify({
      allowed: [{
        name: "mem0",
        allowedAt: new Date().toISOString(),
        packageDir: "",
        packageJsonSha256: "",
      }],
    }));
    const v = await verifyAllow(discovered("mem0", pkg), { path: sb.allowPath });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("entry-incomplete");
  });

  test("legacy name-only rows trigger not-allowed (read() filters them out)", async () => {
    const pkg = sb.makePackage("mem0");
    writeFileSync(sb.allowPath, JSON.stringify({
      allowed: [{ name: "mem0", allowedAt: new Date().toISOString() }],
    }));
    const v = await verifyAllow(discovered("mem0", pkg), { path: sb.allowPath });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("not-allowed");
  });
});
