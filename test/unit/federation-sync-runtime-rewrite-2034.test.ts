/**
 * federation-sync-runtime-rewrite-2034.test.ts — flair#2034 §2 item 2.
 *
 * The federation-sync shim bakes NODE_BIN/FLAIR_BIN at enable time and `flair
 * init` never rewrote them. The rewrite re-points the shim and the platform
 * unit at the current runtime, idempotently, preserving the operator-set
 * interval / target / pass-file, and does nothing when nothing is installed.
 */
import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteFederationSchedulerRuntime } from "../../src/federation/scheduler.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const templateRoot = join(repoRoot, "templates");

const OLD_NODE = "/opt/old/node/bin/node";
const OLD_FLAIR = "/opt/old/tree/dist/cli.js";
const NEW_NODE = "/opt/new/node/bin/node";
const NEW_FLAIR = "/opt/new/tree/dist/cli.js";

let dir: string;
let shimPath: string;
let plistPath: string;

const STALE_SHIM = `#!/bin/sh
set -e
exec "${OLD_NODE}" "${OLD_FLAIR}" federation sync "$@"
`;

const STALE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>dev.flair.federation.sync</string>
  <key>StartInterval</key><integer>600</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FLAIR_ADMIN_PASS_FILE</key><string>/home/u/.flair/admin.pass</string>
    <key>FLAIR_TARGET</key><string>hub.example</string>
  </dict>
</dict></plist>
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-2034-fed-"));
  const binDir = join(dir, ".flair", "bin");
  mkdirSync(binDir, { recursive: true });
  shimPath = join(binDir, "flair-federation-sync");
  plistPath = join(dir, "Library", "LaunchAgents", "dev.flair.federation.sync.plist");
  mkdirSync(dirname(plistPath), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rewrite() {
  return rewriteFederationSchedulerRuntime({
    platformOverride: "darwin",
    shimPathOverride: shimPath,
    launchdPlistOverride: plistPath,
    templateRootOverride: templateRoot,
    homeOverride: "/home/u",
    nodeBin: NEW_NODE,
    flairBin: NEW_FLAIR,
  });
}

describe("rewriteFederationSchedulerRuntime", () => {
  test("rewrites the shim's node and flair paths to the current runtime", () => {
    writeFileSync(shimPath, STALE_SHIM);
    writeFileSync(plistPath, STALE_PLIST);
    const result = rewrite();
    expect(result.shimRewritten).toBe(true);
    const shim = readFileSync(shimPath, "utf8");
    expect(shim).toContain(NEW_NODE);
    expect(shim).toContain(NEW_FLAIR);
    expect(shim).not.toContain(OLD_NODE);
    expect(shim).not.toContain(OLD_FLAIR);
    expect(shim).toContain("federation sync");
  });

  test("preserves the operator-set interval, target and pass-file", () => {
    writeFileSync(shimPath, STALE_SHIM);
    writeFileSync(plistPath, STALE_PLIST);
    rewrite();
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<integer>600</integer>");
    expect(plist).toContain("hub.example");
    expect(plist).toContain("/home/u/.flair/admin.pass");
    expect(plist).toContain("/home/u");
  });

  test("is idempotent: a second run changes nothing", () => {
    writeFileSync(shimPath, STALE_SHIM);
    writeFileSync(plistPath, STALE_PLIST);
    rewrite();
    const second = rewrite();
    expect(second.shimRewritten).toBe(false);
    expect(second.unitRewritten).toBe(false);
  });

  test("does nothing when neither the shim nor the unit exists", () => {
    const result = rewrite();
    expect(result.skipped).toBe(true);
    expect(result.shimRewritten).toBe(false);
    expect(result.unitRewritten).toBe(false);
    expect(existsSync(shimPath)).toBe(false);
  });

  test("rewrites the shim even when only the shim exists", () => {
    writeFileSync(shimPath, STALE_SHIM);
    const result = rewrite();
    expect(result.shimRewritten).toBe(true);
    expect(result.unitRewritten).toBe(false);
    expect(readFileSync(shimPath, "utf8")).toContain(NEW_NODE);
  });
});
