/**
 * integrity-checkpoint-gate-971.test.ts — flair#971 slice 1a, invariant 1.
 *
 * Proves the v3 checkpoint gate: the fixed reason union, the custody predicate
 * (modes, symlinks, ACLs, recorded operator/machine, real uid denial), HMAC and
 * binding refusal, and the N5 anti-rebootstrap rule. No command or route is
 * exercised; the module under test is the library foundation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  INTEGRITY_REASONS,
  INTEGRITY_REASON_REMEDIES,
  checkCustody,
  commitGeneration,
  generationPath,
  initializeIntegrityCustody,
  integrityPaths,
  openIntegrityState,
  type IntegrityStateOptions,
} from "../../src/lib/integrity-state.ts";
import { assertSupportedLocalFilesystem, isSupportedLocalFilesystemType } from "../../src/lib/config-critical-section.ts";

const OPERATOR_UID = process.getuid?.() ?? 0;
const SERVER_UID = OPERATOR_UID === 0 ? 65534 : OPERATOR_UID + 1000;
const MACHINE = "host-a";

let root: string;
let custodyDir: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-971-gate-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  custodyDir = join(root, "custody");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(overrides: Partial<IntegrityStateOptions> = {}): IntegrityStateOptions {
  return {
    custodyDir,
    dataDir,
    serverUid: SERVER_UID,
    operatorUid: OPERATOR_UID,
    machineId: MACHINE,
    newCustody: true,
    ...overrides,
  };
}

function init(overrides: Partial<IntegrityStateOptions> = {}) {
  const result = initializeIntegrityCustody(options(overrides));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`initialization failed: ${result.reason}: ${result.detail}`);
  return result.state;
}

function payload(ids: Record<string, string> = { "mem-a": "permanent" }) {
  const instanceTokens = Object.fromEntries(Object.keys(ids).map((id) => [id, "tok-a"]));
  return {
    baseline: {
      scannedAt: "2026-11-04T00:00:00.000Z",
      scanStartedAt: "2026-11-04T00:00:00.000Z",
      scanEndedAt: "2026-11-04T00:00:01.000Z",
      clockSource: "test",
      byDurability: { permanent: Object.keys(ids).length, persistent: 0, standard: 0, ephemeral: 0 },
      ids,
      instanceTokens,
    },
  };
}

function commitFirst(state = init(), expectedGeneration = 0) {
  const result = commitGeneration({ state, expectedGeneration, checkpoint: payload() });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`commit failed: ${result.reason}: ${result.detail}`);
  return result;
}

describe("checkpoint-gate (invariant 1)", () => {
  it("fixes the twelve reason strings and pairs each with a remedy", () => {
    expect(INTEGRITY_REASONS).toEqual([
      "uninitialized",
      "checkpoint_incompatible",
      "checkpoint_missing",
      "tampered",
      "unavailable",
      "wrong_target",
      "custody_invalid",
      "clock_invalid",
      "scan_failed",
      "store_over_ceiling",
      "commit_conflict",
      "commit_uncertain",
    ]);
    expect(new Set(INTEGRITY_REASONS).size).toBe(12);
    expect(Object.keys(INTEGRITY_REASON_REMEDIES).sort()).toEqual([...INTEGRITY_REASONS].sort());
    for (const reason of INTEGRITY_REASONS) expect(INTEGRITY_REASON_REMEDIES[reason].length).toBeGreaterThan(0);
  });

  it("creates an operator-only directory, key and registry", () => {
    init();
    const paths = integrityPaths(custodyDir);
    expect(statSync(custodyDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.generationsDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.registryPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.keyPath).uid).toBe(OPERATOR_UID);
    expect(statSync(paths.registryPath).uid).toBe(OPERATOR_UID);
    expect(statSync(paths.keyPath).isFile()).toBe(true);
  });

  it("refuses first use without the explicit new-custody flag", () => {
    const result = initializeIntegrityCustody(options({ newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("uninitialized");
    expect(lstatSync(custodyDir, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("refuses a same-machine same-uid arrangement before creating anything", () => {
    const result = initializeIntegrityCustody(options({ serverUid: OPERATOR_UID }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
    expect(lstatSync(custodyDir, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("refuses a root server uid", () => {
    const result = initializeIntegrityCustody(options({ serverUid: 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
  });

  it("rechecks the recorded machine identity on every operation", () => {
    init();
    const result = openIntegrityState(options({ machineId: "host-b", newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
    expect(result.detail).toContain("machine identity");
  });

  it("rechecks the recorded operator uid on every operation", () => {
    init();
    const result = openIntegrityState(options({ operatorUid: OPERATOR_UID + 1, newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
  });

  it("refuses a widened key mode", () => {
    init();
    chmodSync(integrityPaths(custodyDir).keyPath, 0o644);
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
    expect(result.detail).toContain("mode");
  });

  it("refuses a widened custody directory", () => {
    init();
    chmodSync(custodyDir, 0o755);
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
  });

  it("refuses a symlinked key", () => {
    init();
    const paths = integrityPaths(custodyDir);
    renameSync(paths.keyPath, join(root, "key-target"));
    symlinkSync(join(root, "key-target"), paths.keyPath);
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
    expect(result.detail).toContain("symlink");
  });

  it("refuses a symlinked custody directory", () => {
    init();
    const real = join(root, "custody-real");
    renameSync(custodyDir, real);
    symlinkSync(real, custodyDir, "dir");
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
  });

  const hasSetfacl = spawnSync("setfacl", ["--version"], { encoding: "utf8" }).status === 0;
  const aclName = hasSetfacl
    ? "refuses an ACL grant on the key"
    : "refuses an ACL grant on the key (skipped: setfacl is not installed on this host)";
  (hasSetfacl ? it : it.skip)(aclName, () => {
    init();
    const paths = integrityPaths(custodyDir);
    const granted = spawnSync("setfacl", ["-m", `u:${SERVER_UID}:r--`, paths.keyPath], { encoding: "utf8" });
    expect(granted.status).toBe(0);
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
  }, 20_000);

  it("rejects a tampered registry HMAC", () => {
    init();
    const paths = integrityPaths(custodyDir);
    const registry = JSON.parse(readFileSync(paths.registryPath, "utf-8")) as { sequence: number };
    registry.sequence += 1;
    writeFileSync(paths.registryPath, `${JSON.stringify(registry)}\n`);
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("tampered");
  });

  it("rejects a tampered generation HMAC", () => {
    const state = init();
    commitFirst(state);
    const path = generationPath(integrityPaths(custodyDir).generationsDir, 1);
    const checkpoint = JSON.parse(readFileSync(path, "utf-8")) as { baseline: { ids: Record<string, string> } };
    checkpoint.baseline.ids["mem-a"] = "standard";
    writeFileSync(path, `${JSON.stringify(checkpoint)}\n`);
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("tampered");
  });

  it("rejects a v2 record as incompatible rather than reading it", () => {
    const state = init();
    commitFirst(state);
    const path = generationPath(integrityPaths(custodyDir).generationsDir, 1);
    const checkpoint = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    checkpoint.version = 2;
    writeFileSync(path, `${JSON.stringify(checkpoint)}\n`);
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("checkpoint_incompatible");
  });

  it("N5: an absent registry with generation history is custody_invalid, never uninitialized", () => {
    const state = init();
    commitFirst(state);
    const paths = integrityPaths(custodyDir);
    unlinkSync(paths.registryPath);
    unlinkSync(paths.currentPath);
    const opened = openIntegrityState(options({ newCustody: false }));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe("custody_invalid");
    const reinitialized = initializeIntegrityCustody(options({ newCustody: true }));
    expect(reinitialized.ok).toBe(false);
    if (!reinitialized.ok) expect(reinitialized.reason).toBe("custody_invalid");
  });

  it("N5: a registry deletion with one retained generation still refuses a fresh baseline", () => {
    const state = init();
    commitFirst(state);
    const paths = integrityPaths(custodyDir);
    unlinkSync(paths.registryPath);
    unlinkSync(paths.currentPath);
    const result = initializeIntegrityCustody(options({ newCustody: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
    expect(result.detail).toContain("generation history");
  });

  it("exposes a statfs refusal wrapper that accepts the temp filesystem and refuses network types", () => {
    const support = assertSupportedLocalFilesystem(custodyDir);
    expect(support.ok).toBe(true);
    if (support.ok) expect(support.type.length).toBeGreaterThan(0);
    expect(isSupportedLocalFilesystemType(0xef53)).toBe(true);
    expect(isSupportedLocalFilesystemType(0x1a2b3c4d)).toBe(true);
    expect(isSupportedLocalFilesystemType(0x6969)).toBe(false); // NFS
    expect(isSupportedLocalFilesystemType(0xff534d42)).toBe(false); // SMB/CIFS
    expect(isSupportedLocalFilesystemType(0x65735546)).toBe(false); // FUSE
  });

  it("reports the custody predicate directly", () => {
    const state = init();
    const verdict = checkCustody({
      paths: integrityPaths(custodyDir),
      serverUid: SERVER_UID,
      operatorUid: OPERATOR_UID,
      machineId: MACHINE,
      expectedOperatorUid: state.enrollment.operatorUid,
      expectedMachineId: state.enrollment.machineId,
    });
    expect(verdict.ok).toBe(true);
  });

  // The real denial. Mode arithmetic is not evidence: a child process with the
  // server uid must fail to READ the key and fail to WRITE state. Docker CI runs
  // as root, so this executes there; a non-root local host skips it with the
  // reason below rather than pretending mode bits are a syscall.
  const isRoot = (process.getuid?.() ?? -1) === 0;
  const denialName = isRoot
    ? "server uid cannot read the key or write state (real denial)"
    : "server uid cannot read the key or write state (skipped: needs root to drop to a second uid; CI runs this as root)";
  (isRoot ? it : it.skip)(
    denialName,
    () => {
      init();
      // The temp ROOT is traversable; the custody directory itself stays 0700,
      // so a failure below is the key/state modes, not an unreachable parent.
      chmodSync(root, 0o755);
      const paths = integrityPaths(custodyDir);
      const probe = join(custodyDir, "server-write-probe");
      const script = [
        "const fs = require('node:fs');",
        "try { fs.readFileSync(process.argv[1]); } catch (e) {",
        "  if (e.code !== 'EACCES') process.exit(2);",
        "  try { fs.writeFileSync(process.argv[2], 'x'); } catch (e2) {",
        "    process.exit(e2.code === 'EACCES' ? 0 : 3);",
        "  }",
        "  process.exit(11);",
        "}",
        "process.exit(10);",
      ].join("\n");
      const child = spawnSync("node", ["-e", script, paths.keyPath, probe], {
        uid: 65534,
        gid: 65534,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stderr).toBe("");
    },
    20_000,
  );
});
