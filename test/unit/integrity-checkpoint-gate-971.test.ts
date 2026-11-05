/**
 * integrity-checkpoint-gate-971.test.ts — flair#971 slice 1a, invariant 1.
 *
 * Tests the checkpoint gate and custody library.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import ts from "typescript";

import {
  INTEGRITY_REASONS,
  INTEGRITY_REASON_REMEDIES,
  canonicalJson,
  checkCustody,
  commitGeneration,
  generationPath,
  initializeIntegrityCustody,
  integrityPaths,
  machineIdentity,
  openIntegrityState,
  signIntegrityRecord,
  verifyIntegrityRecord,
  tombstoneEnrollment,
  type IntegrityStateOptions,
} from "../../src/lib/integrity-state.ts";
import { assertSupportedLocalFilesystem, isSupportedLocalFilesystemName, isSupportedLocalFilesystemType } from "../../src/lib/config-critical-section.ts";

const OPERATOR_UID = process.getuid?.() ?? 0;
const SERVER_UID = OPERATOR_UID === 0 ? 65534 : OPERATOR_UID + 1000;
const MACHINE = machineIdentity();

let root: string;
let custodyDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-971-gate-"));
  custodyDir = join(root, "custody");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(overrides: Partial<IntegrityStateOptions> = {}): IntegrityStateOptions {
  return {
    custodyDir,
    serverUid: SERVER_UID,
    serverUidSource: "measured",
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
  it("calls the signer only inside prepareIntegrityRecord", () => {
    const path = join(import.meta.dirname, "../../src/lib/integrity-state.ts");
    const source = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
    const calls: { owner: string; line: number }[] = [];
    function visit(node: ts.Node, owner = "module"): void {
      if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? "anonymous";
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "signIntegrityRecord") {
        calls.push({ owner, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
      }
      ts.forEachChild(node, (child) => visit(child, owner));
    }
    visit(source);
    expect(calls.filter((call) => call.owner !== "prepareIntegrityRecord")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("preserves an own __proto__ key in the prepared current record", () => {
    const path = join(import.meta.dirname, "../../src/lib/integrity-state.ts");
    const source = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
    const declarations = source.statements.filter((node) => ts.isFunctionDeclaration(node) &&
      ["prepareIntegrityRecord", "validateCurrentShape"].includes(node.name?.text ?? ""));
    expect(declarations).toHaveLength(2);
    const code = ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let signed = false;
    const prepare = new Function("canonicalJson", "signIntegrityRecord", `${code}\nreturn prepareIntegrityRecord;`)(
      canonicalJson,
      (record: Record<string, unknown>, key: Buffer) => {
        expect(Object.hasOwn(record, "__proto__")).toBe(true);
        expect(Object.getOwnPropertyDescriptor(record, "__proto__")).toEqual({
          value: { marker: true }, writable: true, enumerable: true, configurable: true,
        });
        expect(Object.getPrototypeOf(record)).toBe(null);
        expect(record.hmac).toBe("");
        signed = true;
        return signIntegrityRecord(record, key);
      },
    ) as (build: () => Record<string, unknown>, key: Buffer) => Record<string, unknown>;
    const key = Buffer.alloc(32, 7);
    const record = prepare(() => ({
      version: 3, kind: "current", enrollmentId: "enr-test", generation: 1,
      ["__proto__"]: { marker: true },
    }), key);
    expect(signed).toBe(true);
    expect(Object.hasOwn(record, "__proto__")).toBe(true);
    expect(verifyIntegrityRecord(record, key)).toBe(true);
  });

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

  it("opens a fresh empty root as uninitialized with the enroll remedy", () => {
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result).toMatchObject({ ok: false, reason: "uninitialized", remedy: INTEGRITY_REASON_REMEDIES.uninitialized });
    expect(lstatSync(custodyDir, { throwIfNoEntry: false })).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });

  it("opens custody with a key but no registry as uninitialized", () => {
    const state = init();
    unlinkSync(state.paths.registryPath);
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result).toMatchObject({ ok: false, reason: "uninitialized", remedy: INTEGRITY_REASON_REMEDIES.uninitialized });
    expect(readFileSync(state.paths.keyPath)).toHaveLength(32);
  });

  it("refuses a custody directory without a key and names the missing key", () => {
    mkdirSync(custodyDir, { mode: 0o700 });
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    if (result.ok) return;
    expect(result.detail).toContain("cannot read the custody key");
    expect(result.detail).toContain(integrityPaths(custodyDir).keyPath);
    expect(readdirSync(custodyDir)).toEqual([]);
  });

  it("refuses an invalid machine identity before creating custody files", () => {
    for (const machineId of ["", 42 as unknown as string]) {
      const result = initializeIntegrityCustody(options({ machineId }));
      expect(result).toMatchObject({ ok: false, reason: "custody_invalid" });
      expect(lstatSync(custodyDir, { throwIfNoEntry: false })).toBeUndefined();
    }
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

  it("compares the supplied machine identity at open", () => {
    init();
    const result = openIntegrityState(options({ machineId: "host-b", newCustody: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
    expect(result.detail).toContain("machine identity");
  });

  it("compares the supplied operator uid at open", () => {
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

  for (const filename of ["registry.json", "CURRENT"]) {
    it(`refuses a dangling ${filename} symlink at open and custody check`, () => {
      const state = init();
      const path = join(custodyDir, filename);
      rmSync(path, { force: true });
      symlinkSync(join(root, "absent-target"), path);
      const opened = openIntegrityState(options({ newCustody: false }));
      expect(opened).toMatchObject({ ok: false, reason: "custody_invalid" });
      if (!opened.ok) expect(opened.detail).toBe(`${path} is a symlink`);
      const custody = checkCustody({
        paths: state.paths, serverUid: SERVER_UID, operatorUid: OPERATOR_UID, machineId: MACHINE,
      });
      expect(custody).toMatchObject({ ok: false, reason: "custody_invalid" });
      if (!custody.ok) expect(custody.detail).toBe(`${path} is a symlink`);
    });
  }

  it("holds a registry that appears empty before the locked publication", () => {
    const paths = integrityPaths(custodyDir);
    const result = initializeIntegrityCustody(options({
      beforeRegistryPublication: () => { writeFileSync(paths.registryPath, "", { mode: 0o600 }); },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
    expect(result.detail).toContain("already exists");
    expect(readFileSync(paths.registryPath).byteLength).toBe(0);
  });

  it("refuses a symlinked generation at open and at the custody check", () => {
    const state = init();
    commitFirst(state);
    const paths = integrityPaths(custodyDir);
    const genPath = generationPath(paths.generationsDir, 1);
    const outside = join(root, "held-generation.json");
    renameSync(genPath, outside);
    symlinkSync(outside, genPath);
    const custody = checkCustody({
      paths, serverUid: SERVER_UID, operatorUid: OPERATOR_UID, machineId: MACHINE,
    });
    expect(custody).toMatchObject({ ok: false, reason: "custody_invalid" });
    if (!custody.ok) expect(custody.detail).toBe(`${genPath} is a symlink`);
    const opened = openIntegrityState(options({ newCustody: false }));
    expect(opened).toMatchObject({ ok: false, reason: "custody_invalid" });
    if (!opened.ok) expect(opened.detail).toBe(`${genPath} is a symlink`);
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

  it("refuses a symlinked custody path before writing its target", () => {
    const target = join(root, "custody-target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, custodyDir, "dir");
    const result = initializeIntegrityCustody(options());
    const paths = integrityPaths(target);
    expect(lstatSync(paths.keyPath, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(paths.registryPath, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(paths.generationsDir, { throwIfNoEntry: false })).toBeUndefined();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("custody_invalid");
  });

  const hasSetfacl = spawnSync("setfacl", ["--version"], { encoding: "utf8" }).status === 0;
  (process.platform === "darwin" || hasSetfacl || process.env.GITHUB_JOB === "custody-denial-root" ? it : it.skip)("refuses an ACL entry on the key", () => {
    expect(process.platform === "darwin" || hasSetfacl).toBe(true);
    commitFirst();
    const paths = integrityPaths(custodyDir);
    expect(openIntegrityState(options({ newCustody: false })).ok).toBe(true);
    const granted = process.platform === "darwin"
      ? spawnSync("chmod", ["+a", "everyone allow read", paths.keyPath], { encoding: "utf8" })
      : spawnSync("setfacl", ["-m", `u:${SERVER_UID}:r--,m::---`, paths.keyPath], { encoding: "utf8" });
    expect(granted.status).toBe(0);
    expect(statSync(paths.keyPath).mode & 0o777).toBe(0o600);
    const result = openIntegrityState(options({ newCustody: false }));
    expect(result).toMatchObject({ ok: false, reason: "custody_invalid" });
    if (!result.ok) expect(result.detail).toMatch(/^an ACL (entry )?is present on /);
    const removed = process.platform === "darwin"
      ? spawnSync("chmod", ["-N", paths.keyPath], { encoding: "utf8" })
      : spawnSync("setfacl", ["-b", paths.keyPath], { encoding: "utf8" });
    expect(removed.status).toBe(0);
    expect(openIntegrityState(options({ newCustody: false })).ok).toBe(true);
    chmodSync(paths.keyPath, 0o644);
    const modeOnly = openIntegrityState(options({ newCustody: false }));
    expect(modeOnly).toMatchObject({ ok: false, reason: "custody_invalid" });
    if (!modeOnly.ok) expect(modeOnly.detail).toBe(`${paths.keyPath} mode is 644, expected 600`);
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

  it("refuses signed checkpoints with malformed journal entries on open", () => {
    const state = init();
    commitFirst(state);
    const path = generationPath(state.paths.generationsDir, 1);
    const checkpoint = JSON.parse(readFileSync(path, "utf-8"));
    for (const entry of [
      { at: 42, kind: null, detail: [] },
      null, [], "entry", {},
      { at: 42, kind: "scan" },
      { at: "2026-11-04T00:00:00.000Z", kind: null },
      { at: "2026-11-04T00:00:00.000Z", kind: "scan", detail: [] },
    ]) {
      const signed = signIntegrityRecord({ ...checkpoint, journal: [entry] }, state.key);
      expect(verifyIntegrityRecord(signed, state.key)).toBe(true);
      writeFileSync(path, `${canonicalJson(signed)}\n`);
      const opened = openIntegrityState(options({ newCustody: false }));
      expect(opened).toMatchObject({ ok: false, reason: "tampered" });
      if (!opened.ok) expect(opened.detail).toContain("not a valid v3 record");
    }
  });

  it("commits and reopens journal entries with and without detail", () => {
    const state = init();
    const journal = [
      { at: "2026-11-04T00:00:00.000Z", kind: "scan" },
      { at: "2026-11-04T00:00:01.000Z", kind: "scan", detail: "complete" },
    ];
    expect(commitGeneration({ state, expectedGeneration: 0, checkpoint: { ...payload(), journal } }).ok).toBe(true);
    const opened = openIntegrityState(options({ newCustody: false }));
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.state.checkpoint?.journal).toEqual(journal);
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

  it("tombstones an enrollment, advances the sequence and refuses a stale expectation", () => {
    const state = init();
    commitFirst(state);
    const stale = tombstoneEnrollment({ ...options(), expectedSequence: 0 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.status).toBe("commit_conflict");
    const first = tombstoneEnrollment({ ...options(), expectedSequence: 1 });
    expect(first).toMatchObject({ ok: true, sequence: 2 });
    const opened = openIntegrityState(options({ newCustody: false }));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe("custody_invalid");
  });

  it("refuses tombstone sequence overflow without changing custody files and reopens the registry", () => {
    const state = init();
    commitFirst(state);
    const paths = state.paths;
    const registry = JSON.parse(readFileSync(paths.registryPath, "utf-8"));
    registry.sequence = Number.MAX_SAFE_INTEGER;
    writeFileSync(paths.registryPath, `${canonicalJson(signIntegrityRecord(registry, state.key))}\n`);
    const before = readFileSync(paths.registryPath);
    const pointerBefore = readFileSync(paths.currentPath);
    const generationBefore = readFileSync(generationPath(paths.generationsDir, 1));
    const entriesBefore = readdirSync(paths.custodyDir).sort();
    const generationsBefore = readdirSync(paths.generationsDir).sort();
    expect(openIntegrityState(options({ newCustody: false })).ok).toBe(true);
    const result = tombstoneEnrollment({ ...options(), expectedSequence: Number.MAX_SAFE_INTEGER });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("safe integer range");
    expect(readFileSync(paths.registryPath)).toEqual(before);
    expect(readFileSync(paths.currentPath)).toEqual(pointerBefore);
    expect(readFileSync(generationPath(paths.generationsDir, 1))).toEqual(generationBefore);
    expect(readdirSync(paths.custodyDir).sort()).toEqual(entriesBefore);
    expect(readdirSync(paths.generationsDir).sort()).toEqual(generationsBefore);
    const reopened = openIntegrityState(options({ newCustody: false }));
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.state.registry.sequence).toBe(Number.MAX_SAFE_INTEGER);
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

  it("refuses new custody when a retained generation was renamed", () => {
    const state = init();
    commitFirst(state);
    const paths = integrityPaths(custodyDir);
    renameSync(generationPath(paths.generationsDir, 1), join(paths.generationsDir, "retained-checkpoint"));
    const opened = openIntegrityState(options({ newCustody: false }));
    for (const path of [paths.keyPath, paths.registryPath, paths.currentPath]) unlinkSync(path);
    const result = initializeIntegrityCustody(options({ newCustody: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("custody_invalid");
    expect(lstatSync(paths.keyPath, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(paths.registryPath, { throwIfNoEntry: false })).toBeUndefined();
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe("custody_invalid");
      expect(opened.detail).toContain("unexpected generation entry");
    }
  });

  it("exposes a statfs refusal wrapper that accepts the temp filesystem and refuses network types", () => {
    const support = assertSupportedLocalFilesystem(custodyDir);
    expect(support.ok).toBe(true);
    if (support.ok) expect(support.type.length).toBeGreaterThan(0);
    expect(isSupportedLocalFilesystemType(0xef53)).toBe(true);
    expect(isSupportedLocalFilesystemType(0x6969)).toBe(false); // NFS
    expect(isSupportedLocalFilesystemType(0xff534d42)).toBe(false); // SMB/CIFS
    expect(isSupportedLocalFilesystemType(0x65735546)).toBe(false); // FUSE
    expect(isSupportedLocalFilesystemName("apfs")).toBe(true);
    expect(isSupportedLocalFilesystemName("hfs")).toBe(true);
    expect(isSupportedLocalFilesystemName("nfs")).toBe(false);
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

  it("refuses a missing server uid or an empty source label", () => {
    const missing = initializeIntegrityCustody({ ...options(), serverUid: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("custody_invalid");
    const unsourced = initializeIntegrityCustody({ ...options(), serverUidSource: "" });
    expect(unsourced.ok).toBe(false);
    if (!unsourced.ok) expect(unsourced.reason).toBe("custody_invalid");
    expect(lstatSync(custodyDir, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("refuses a regular file at the generation directory", () => {
    const state = init();
    commitFirst(state);
    const paths = integrityPaths(custodyDir);
    unlinkSync(paths.registryPath);
    unlinkSync(paths.currentPath);
    renameSync(paths.generationsDir, join(root, "generations-real"));
    writeFileSync(paths.generationsDir, "not a directory");
    const opened = openIntegrityState(options({ newCustody: false }));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe("custody_invalid");
      expect(opened.detail).toContain("not a plain dir");
    }
  });

  it("canonical JSON value checks", () => {
    const sparse: unknown[] = [1];
    sparse.length = 3;
    for (const value of [undefined, () => 1, Symbol("s"), 1n, NaN, Infinity, -Infinity, new Date(0), /x/, new Map(), sparse]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(JSON.parse(canonicalJson({ b: 1, a: [true, null, "x"] }))).toEqual({ a: [true, null, "x"], b: 1 });
  });

  it("refuses accessors, symbol keys, hidden properties and extra array properties", () => {
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    const hidden = Object.defineProperty({}, "value", { value: 1 });
    const symbolKey = { [Symbol("value")]: 1 };
    const extraArray = Object.assign([1], { extra: 2 });
    const arrayAccessor = Object.defineProperty([1], "0", { enumerable: true, get: () => 1 });
    for (const value of [accessor, hidden, symbolKey, extraArray, arrayAccessor]) {
      expect(() => canonicalJson(value)).toThrow();
    }
  });

  const uidProbe = spawnSync("setpriv", [
    `--reuid=${SERVER_UID}`, `--regid=${SERVER_UID}`, "--clear-groups", "node", "-e",
    `process.exit(process.getuid() === ${SERVER_UID} && process.getgid() === ${SERVER_UID} ? 0 : 1)`,
  ], { encoding: "utf8", timeout: 15_000 });
  (process.env.GITHUB_JOB === "custody-denial-root" || (process.platform === "linux" && uidProbe.status === 0) ? it : it.skip)(
    "server uid cannot read the key or write state on accepted 0700 custody (real denial)",
    () => {
      expect(process.platform).toBe("linux");
      expect(process.getuid?.()).toBe(0);
      expect(uidProbe.error).toBeUndefined();
      expect(uidProbe.status).toBe(0);
      const state = init();
      chmodSync(root, 0o755);
      const paths = integrityPaths(custodyDir);
      expect(statSync(custodyDir).mode & 0o777).toBe(0o700);
      expect(checkCustody({
        paths,
        serverUid: SERVER_UID,
        operatorUid: OPERATOR_UID,
        machineId: MACHINE,
        expectedOperatorUid: state.enrollment.operatorUid,
        expectedMachineId: state.enrollment.machineId,
      })).toEqual({ ok: true });
      const probe = join(custodyDir, "server-write-probe");
      const script = [
        "const fs = require('node:fs');",
        `if (process.getuid() !== ${SERVER_UID} || process.getgid() !== ${SERVER_UID}) process.exit(4);`,
        "try { fs.readFileSync(process.argv[1]); } catch (e) {",
        "  if (e.code !== 'EACCES') process.exit(2);",
        "  try { fs.writeFileSync(process.argv[2], 'x'); } catch (e2) {",
        "    process.exit(e2.code === 'EACCES' ? 0 : 3);",
        "  }",
        "  process.exit(11);",
        "}",
        "process.exit(10);",
      ].join("\n");
      const child = spawnSync(
        "setpriv",
        [
          `--reuid=${SERVER_UID}`,
          `--regid=${SERVER_UID}`,
          "--clear-groups",
          "node",
          "-e",
          script,
          paths.keyPath,
          probe,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stderr).toBe("");
    },
    20_000,
  );
});
