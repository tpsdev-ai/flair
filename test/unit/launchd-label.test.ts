/**
 * launchd-label.test.ts — flair#693: instance-scoped launchd label.
 *
 * A bare "ai.tpsdev.flair" label used to be global to the current macOS
 * user's launchd session — a second Flair instance on one host (dev+prod,
 * a second user, the Harper-app embedded-component shape) could silently
 * unload/replace the OTHER instance's daemon. The label now incorporates a
 * short hash of the resolved data dir (launchdLabel), and
 * resolveLaunchdLabel/migrateLegacyLaunchdLabel/ensureLaunchdServiceLoaded
 * find + cleanly migrate a pre-flair#693 install off the bare legacy
 * label so it's never orphaned.
 *
 * SAFETY: every test here uses a temp dir standing in for
 * ~/Library/LaunchAgents (the `launchAgentsDir` param all the helpers
 * accept) and a mocked launchctl runner that just records calls — never
 * the real filesystem path, never a real launchctl invocation. See
 * test/unit/upgrade-data-snapshot.test.ts's header for why exercising the
 * real launchd path in a test is actively dangerous on a shared dev host.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_LAUNCHD_LABEL,
  launchdLabel,
  launchdPlistPath,
  cleanupLegacyLaunchdPlist,
  readPlistRootPath,
  resolveLaunchdLabel,
  migrateLegacyLaunchdLabel,
  ensureLaunchdServiceLoaded,
} from "../../src/cli.ts";
import { isLaunchdValidationRefusal } from "../../src/lib/launchd-domain-preflight.ts";

/** The GUI domain the targeted launchctl commands name (flair#2040). */
const GUI = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;

/**
 * A recording launchctl stand-in that behaves like launchd about PRESENCE
 * (flair#2040): `print <domain>/<label>` succeeds while the job is loaded and
 * fails "Could not find service" once a `bootout` of it has been recorded —
 * unless `bootoutSticks` is false, when the job stays loaded (a bootout that
 * did not take). Jobs in `absent` are never loaded.
 */
function launchdStandIn(opts: { bootoutSticks?: boolean; absent?: string[] } = {}) {
  const calls: string[] = [];
  const gone = new Set<string>(opts.absent ?? []);
  const run = (cmd: string) => {
    calls.push(cmd);
    const [, verb, target] = cmd.match(/^launchctl (\S+) (\S+)/) ?? [];
    if (verb === "bootout" && opts.bootoutSticks !== false) gone.add(target);
    if (verb === "print" && gone.has(target)) throw new Error(`Could not find service "${target}"`);
  };
  return { calls, run };
}

function fakePlist(label: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/some/harper.js</string>
    <string>run</string>
    <string>.</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>`;
}

describe("launchdLabel", () => {
  test("two different data dirs produce two different labels", () => {
    const a = launchdLabel("/Users/alice/.flair/data");
    const b = launchdLabel("/Users/bob/.flair/data");
    expect(a).not.toBe(b);
  });

  test("the same data dir produces the identical label across invocations", () => {
    const dataDir = "/Users/alice/.flair/data";
    const first = launchdLabel(dataDir);
    const second = launchdLabel(dataDir);
    const third = launchdLabel(dataDir);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  test("default single-instance install produces a stable, documented label", () => {
    // The documented format: ai.tpsdev.flair.<8-hex-char sha256 of the
    // resolved data dir> (see CHANGELOG.md [Unreleased]). For the default
    // data dir (~/.flair/data) this is a fixed value per machine/user,
    // stable across every re-run of init/start/stop.
    const defaultDataDir = join(process.env.HOME ?? "/Users/test", ".flair", "data");
    const label = launchdLabel(defaultDataDir);
    expect(label).toMatch(/^ai\.tpsdev\.flair\.[0-9a-f]{8}$/);
    expect(launchdLabel(defaultDataDir)).toBe(label);
  });

  test("label is always prefixed with the legacy base label", () => {
    expect(launchdLabel("/anywhere")).toStartWith(`${LEGACY_LAUNCHD_LABEL}.`);
  });

  test("relative and absolute paths to the same directory resolve to the same label", () => {
    const cwdRelative = "./some/relative/dir";
    const resolved = join(process.cwd(), "some", "relative", "dir");
    expect(launchdLabel(cwdRelative)).toBe(launchdLabel(resolved));
  });
});

describe("resolveLaunchdLabel / migrateLegacyLaunchdLabel / ensureLaunchdServiceLoaded", () => {
  let launchAgentsDir: string;
  const dataDir = "/Users/alice/.flair/data";

  beforeEach(() => {
    launchAgentsDir = mkdtempSync(join(tmpdir(), "flair-launchd-label-test-"));
  });

  afterEach(() => {
    rmSync(launchAgentsDir, { recursive: true, force: true });
  });

  test("nothing registered yet -> resolves to the new label, not legacy", () => {
    const { label, isLegacy } = resolveLaunchdLabel(dataDir, launchAgentsDir);
    expect(isLegacy).toBe(false);
    expect(label).toBe(launchdLabel(dataDir));
  });

  test("only the new-labeled plist present -> resolves to it", () => {
    const newLabel = launchdLabel(dataDir);
    writeFileSync(launchdPlistPath(newLabel, launchAgentsDir), fakePlist(newLabel));
    const resolved = resolveLaunchdLabel(dataDir, launchAgentsDir);
    expect(resolved.isLegacy).toBe(false);
    expect(resolved.label).toBe(newLabel);
  });

  test("only the legacy-labeled plist present -> detected and preferred over nothing", () => {
    writeFileSync(launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir), fakePlist(LEGACY_LAUNCHD_LABEL));
    const resolved = resolveLaunchdLabel(dataDir, launchAgentsDir);
    expect(resolved.isLegacy).toBe(true);
    expect(resolved.label).toBe(LEGACY_LAUNCHD_LABEL);
  });

  test("both present -> prefers the new instance-scoped label", () => {
    const newLabel = launchdLabel(dataDir);
    writeFileSync(launchdPlistPath(newLabel, launchAgentsDir), fakePlist(newLabel));
    writeFileSync(launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir), fakePlist(LEGACY_LAUNCHD_LABEL));
    const resolved = resolveLaunchdLabel(dataDir, launchAgentsDir);
    expect(resolved.isLegacy).toBe(false);
    expect(resolved.label).toBe(newLabel);
  });

  test("migrateLegacyLaunchdLabel is a no-op when nothing legacy exists", () => {
    const calls: string[] = [];
    const result = migrateLegacyLaunchdLabel(dataDir, (cmd) => calls.push(cmd), launchAgentsDir);
    expect(result.migrated).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("migrateLegacyLaunchdLabel is a no-op when the new label is already registered", () => {
    const newLabel = launchdLabel(dataDir);
    writeFileSync(launchdPlistPath(newLabel, launchAgentsDir), fakePlist(newLabel));
    writeFileSync(launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir), fakePlist(LEGACY_LAUNCHD_LABEL));
    const calls: string[] = [];
    const result = migrateLegacyLaunchdLabel(dataDir, (cmd) => calls.push(cmd), launchAgentsDir);
    expect(result.migrated).toBe(false);
    expect(calls.length).toBe(0);
    // Legacy leftover is untouched by migrate (uninstall's job to sweep both)
    expect(existsSync(launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir))).toBe(true);
  });

  test("migrates a legacy install: unloads legacy, writes new plist with the new label, removes legacy file", () => {
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, fakePlist(LEGACY_LAUNCHD_LABEL));

    const { calls, run } = launchdStandIn();
    const result = migrateLegacyLaunchdLabel(dataDir, run, launchAgentsDir);

    const newLabel = launchdLabel(dataDir);
    expect(result.migrated).toBe(true);
    expect(result.label).toBe(newLabel);

    // Call order (flair#2040): is the LEGACY job loaded? boot it out, targeted
    // at the GUI domain; then VERIFY it is gone before migrating.
    expect(calls).toEqual([
      `launchctl print ${GUI}/${LEGACY_LAUNCHD_LABEL}`,
      `launchctl bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`,
      `launchctl print ${GUI}/${LEGACY_LAUNCHD_LABEL}`,
    ]);

    // Legacy plist file removed, new one written with the label swapped
    // (rest of the plist content preserved byte-for-byte).
    expect(existsSync(legacyPath)).toBe(false);
    const newPath = launchdPlistPath(newLabel, launchAgentsDir);
    expect(existsSync(newPath)).toBe(true);
    const newContent = readFileSync(newPath, "utf-8");
    expect(newContent).toContain(`<key>Label</key><string>${newLabel}</string>`);
    expect(newContent).not.toContain(`<string>${LEGACY_LAUNCHD_LABEL}</string>`);
    expect(newContent).toContain("<string>/usr/bin/node</string>");
  });

  test("ensureLaunchdServiceLoaded on a legacy install: boot out legacy BEFORE bootstrap/kickstart under the new label (call order)", () => {
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, fakePlist(LEGACY_LAUNCHD_LABEL));

    const { calls, run } = launchdStandIn();
    const result = ensureLaunchdServiceLoaded(dataDir, run, launchAgentsDir);

    const newLabel = launchdLabel(dataDir);
    expect(result.migrated).toBe(true);
    expect(result.label).toBe(newLabel);

    // In this order, every call naming the GUI domain (flair#2040): boot out
    // legacy and VERIFY it gone, boot out new, bootstrap new, kickstart new.
    expect(calls).toEqual([
      `launchctl print ${GUI}/${LEGACY_LAUNCHD_LABEL}`,
      `launchctl bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`,
      `launchctl print ${GUI}/${LEGACY_LAUNCHD_LABEL}`,
      `launchctl bootout ${GUI}/${newLabel}`,
      `launchctl bootstrap ${GUI} "${launchdPlistPath(newLabel, launchAgentsDir)}"`,
      `launchctl kickstart ${GUI}/${newLabel}`,
    ]);

    // There is never a moment with both registered: legacy file is gone,
    // new one exists, by the time this returns.
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(launchdPlistPath(newLabel, launchAgentsDir))).toBe(true);
  });

  test("migrateLegacyLaunchdLabel REFUSES when the legacy job cannot be shown unloaded — no second job for one data dir (flair#2040)", () => {
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, fakePlist(LEGACY_LAUNCHD_LABEL));
    const legacyBytes = readFileSync(legacyPath, "utf-8");
    const { run } = launchdStandIn({ bootoutSticks: false });
    expect(() => migrateLegacyLaunchdLabel(dataDir, run, launchAgentsDir, undefined, { settleMs: 0, sleep: () => {} }))
      .toThrow(/not migrating off the legacy launchd label: .*the job is still loaded/);
    expect(readFileSync(legacyPath, "utf-8")).toBe(legacyBytes);
    expect(existsSync(launchdPlistPath(launchdLabel(dataDir), launchAgentsDir))).toBe(false);
  });

  test("ensureLaunchdServiceLoaded on an already-current install: no migration, just bootout -> bootstrap -> kickstart", () => {
    const newLabel = launchdLabel(dataDir);
    writeFileSync(launchdPlistPath(newLabel, launchAgentsDir), fakePlist(newLabel));

    const calls: string[] = [];
    const result = ensureLaunchdServiceLoaded(dataDir, (cmd) => calls.push(cmd), launchAgentsDir);

    expect(result.migrated).toBe(false);
    // flair#872: boot out before bootstrap so a rewritten plist is re-read.
    // flair#2040: every command names the GUI domain.
    expect(calls).toEqual([
      `launchctl bootout ${GUI}/${newLabel}`,
      `launchctl bootstrap ${GUI} "${launchdPlistPath(newLabel, launchAgentsDir)}"`,
      `launchctl kickstart ${GUI}/${newLabel}`,
    ]);
  });

  test("ensureLaunchdServiceLoaded: a failed bootstrap while the job is STILL loaded is tolerated (non-strict), a kickstart failure propagates", () => {
    const newLabel = launchdLabel(dataDir);
    writeFileSync(launchdPlistPath(newLabel, launchAgentsDir), fakePlist(newLabel));

    const calls: string[] = [];
    const runLaunchctl = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("launchctl bootstrap")) throw new Error("Bootstrap failed: 5: Input/output error");
      if (cmd.includes("launchctl kickstart")) throw new Error("could not find service");
      // `print` succeeds: the job is still loaded.
    };

    expect(() => ensureLaunchdServiceLoaded(dataDir, runLaunchctl, launchAgentsDir, { settleMs: 0, sleep: () => {} }))
      .toThrow(/kickstart .* failed: could not find service \(bootstrap had failed: Bootstrap failed: 5/);
    expect(calls).toEqual([
      `launchctl bootout ${GUI}/${newLabel}`,
      `launchctl bootstrap ${GUI} "${launchdPlistPath(newLabel, launchAgentsDir)}"`,
      `launchctl print ${GUI}/${newLabel}`,
      `launchctl kickstart ${GUI}/${newLabel}`,
    ]);
  });

  test("ensureLaunchdServiceLoaded strict: a job still loaded after a failed bootstrap THROWS instead of kickstarting the old definition", () => {
    const newLabel = launchdLabel(dataDir);
    writeFileSync(launchdPlistPath(newLabel, launchAgentsDir), fakePlist(newLabel));
    const calls: string[] = [];
    const runLaunchctl = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("launchctl bootstrap")) throw new Error("Bootstrap failed: 5: Input/output error");
    };
    expect(() => ensureLaunchdServiceLoaded(dataDir, runLaunchctl, launchAgentsDir, { strict: true, settleMs: 0, sleep: () => {} }))
      .toThrow(/still loaded with its previous definition/);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
  });

  test("ensureLaunchdServiceLoaded: bootout is asynchronous — a bootstrap that fails while the old job is leaving is retried ONCE after it leaves", () => {
    const newLabel = launchdLabel(dataDir);
    writeFileSync(launchdPlistPath(newLabel, launchAgentsDir), fakePlist(newLabel));
    const calls: string[] = [];
    let bootstraps = 0;
    const runLaunchctl = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("launchctl bootstrap") && ++bootstraps === 1) throw new Error("Bootstrap failed: 5: Input/output error");
      if (cmd.includes("launchctl print")) throw new Error("Could not find service"); // gone now
    };
    ensureLaunchdServiceLoaded(dataDir, runLaunchctl, launchAgentsDir, { strict: true, settleMs: 0, sleep: () => {} });
    expect(calls.filter((c) => c.includes("bootstrap")).length).toBe(2);
    expect(calls[calls.length - 1]).toBe(`launchctl kickstart ${GUI}/${newLabel}`);
  });

  test("no bare 'ai.tpsdev.flair' string literals remain in operational label call sites (structural)", async () => {
    const src = await Bun.file(join(import.meta.dirname, "..", "..", "src", "cli.ts")).text();
    // Every occurrence of the bare legacy label as a double-quoted string
    // literal, in CODE (not a `//` comment line), must be the
    // LEGACY_LAUNCHD_LABEL constant declaration itself — no other code
    // path should hardcode it.
    const codeLines = src.split("\n").filter((line) => !line.trim().startsWith("//"));
    const literalOccurrences = codeLines.join("\n").match(/"ai\.tpsdev\.flair"/g) ?? [];
    // Exactly one: `const LEGACY_LAUNCHD_LABEL = "ai.tpsdev.flair";`
    expect(literalOccurrences.length).toBe(1);
    expect(src).toContain('const LEGACY_LAUNCHD_LABEL = "ai.tpsdev.flair";');
  });

  // flair#966: init must not unload/delete a legacy plist that belongs to
  // a DIFFERENT data dir. The ownership test reads ROOTPATH from the plist
  // via readPlistRootPath (the same helper the init code uses).
  test("readPlistRootPath: matches own data dir, rejects foreign", () => {
    const dataDirA = "/Users/alice/.flair/data";
    const dataDirB = "/Users/bob/.flair/data";

    // A plist whose ROOTPATH declares it belongs to dataDirA.
    function plistWithRootPath(label: string, rootPath: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROOTPATH</key><string>${rootPath}</string>
  </dict>
</dict>
</plist>`;
    }

    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, plistWithRootPath(LEGACY_LAUNCHD_LABEL, dataDirA));

    const declared = readPlistRootPath(legacyPath);
    expect(declared).not.toBeNull();

    const { resolve } = require("node:path");
    // It matches its own data dir.
    expect(resolve(declared!) === resolve(dataDirA)).toBe(true);
    // It does NOT match a different data dir — this is the assertion that
    // would have caught flair#966.
    expect(resolve(declared!) === resolve(dataDirB)).toBe(false);
  });

  test("readPlistRootPath: plist with no ROOTPATH key returns null", () => {
    // A hand-written or foreign plist that lacks ROOTPATH entirely.
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, fakePlist(LEGACY_LAUNCHD_LABEL));

    expect(readPlistRootPath(legacyPath)).toBeNull();
  });

  test("readPlistRootPath: missing file returns null", () => {
    const nonexistent = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    expect(readPlistRootPath(nonexistent)).toBeNull();
  });

  test("readPlistRootPath: XML-escaped ROOTPATH is decoded before return", () => {
    // The real data dir contains a literal ampersand.
    const dataDirWithAmpersand = "/Users/alice/Flair & Data";
    // The plist stores this XML-escaped: & -> &amp;
    const escapedRootPath = "/Users/alice/Flair &amp; Data";

    function plistWithEscapedRootPath(label: string, escapedPath: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROOTPATH</key><string>${escapedPath}</string>
  </dict>
</dict>
</plist>`;
    }

    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, plistWithEscapedRootPath(LEGACY_LAUNCHD_LABEL, escapedRootPath));

    const declared = readPlistRootPath(legacyPath);
    expect(declared).toBe(dataDirWithAmpersand);
  });

  // ── flair#966 behavioural regression: init's cleanup path ──────────
  // These tests drive cleanupLegacyLaunchdPlist (the function init calls)
  // with a mock LaunchctlRunner. They guard the actual bug: if someone
  // reverts init to the old unconditional unload+unlink while leaving
  // readPlistRootPath intact, these tests FAIL because the mock
  // runLaunchctl is invoked for a foreign plist.

  test("cleanupLegacyLaunchdPlist: leaves a foreign legacy plist alone (the flair#966 regression guard)", () => {
    const myDataDir = "/Users/alice/.flair/data";
    const foreignDataDir = "/Users/bob/.flair/data";

    // A legacy plist whose ROOTPATH declares it belongs to bob, not alice.
    function plistWithRootPath(label: string, rootPath: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROOTPATH</key><string>${rootPath}</string>
  </dict>
</dict>
</plist>`;
    }

    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, plistWithRootPath(LEGACY_LAUNCHD_LABEL, foreignDataDir));

    const launchctlCalls: string[] = [];
    const result = cleanupLegacyLaunchdPlist(myDataDir, launchAgentsDir, (cmd) => {
      launchctlCalls.push(cmd);
    });

    // The plist must still exist — we do NOT delete a foreign instance's
    // service registration.
    expect(existsSync(legacyPath)).toBe(true);

    // launchctl unload must NOT have been invoked.
    expect(launchctlCalls.length).toBe(0);

    // The result must report the skip and name the foreign data dir.
    expect(result.action).toBe("skipped-foreign");
    if (result.action === "skipped-foreign") {
      const { resolve } = require("node:path");
      expect(result.foreignDataDir).toBe(resolve(foreignDataDir));
    }
  });

  test("cleanupLegacyLaunchdPlist: unloads and deletes a legacy plist that IS ours", () => {
    const myDataDir = "/Users/alice/.flair/data";

    function plistWithRootPath(label: string, rootPath: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROOTPATH</key><string>${rootPath}</string>
  </dict>
</dict>
</plist>`;
    }

    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, plistWithRootPath(LEGACY_LAUNCHD_LABEL, myDataDir));

    const { calls: launchctlCalls, run } = launchdStandIn();
    const result = cleanupLegacyLaunchdPlist(myDataDir, launchAgentsDir, run);

    // The plist must be gone — it was ours.
    expect(existsSync(legacyPath)).toBe(false);

    // flair#2040: a read-only `print` asks whether the legacy job is loaded in
    // the GUI domain, ONE targeted boot-out, then a `print` that VERIFIES it
    // is gone.
    expect(launchctlCalls).toEqual([
      `launchctl print ${GUI}/${LEGACY_LAUNCHD_LABEL}`,
      `launchctl bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`,
      `launchctl print ${GUI}/${LEGACY_LAUNCHD_LABEL}`,
    ]);

    // The result must report the unload.
    expect(result).toEqual({ action: "unloaded", deleteFailed: undefined });
  });

  test("cleanupLegacyLaunchdPlist: a boot-out that does not take is REPORTED as unconfirmed, the plist is KEPT, and there is no check mark (flair#2040)", () => {
    const myDataDir = "/Users/alice/.flair/data";
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    const legacyBytes =
      `<plist><dict><key>Label</key><string>${LEGACY_LAUNCHD_LABEL}</string><key>EnvironmentVariables</key><dict><key>ROOTPATH</key><string>${myDataDir}</string></dict></dict></plist>`;
    writeFileSync(legacyPath, legacyBytes);
    const { run } = launchdStandIn({ bootoutSticks: false });
    const logged: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
    let result;
    try {
      result = cleanupLegacyLaunchdPlist(myDataDir, launchAgentsDir, run, undefined, { settleMs: 0, sleep: () => {} });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    expect(result!.action).toBe("unload-unconfirmed");
    if (result!.action === "unload-unconfirmed") expect(result!.unloadFailed).toContain("the job is still loaded");
    // A job that may still be loaded keeps its plist: removing it would orphan the job.
    expect(readFileSync(legacyPath, "utf-8")).toBe(legacyBytes);
    expect(logged.join("\n")).toContain("was left in place");
    expect(logged.join("\n")).not.toContain("✓");
  });

  test("cleanupLegacyLaunchdPlist: retiring a legacy plist whose job is gone prints NO check mark — only the strict verifier licenses one (flair#2040)", () => {
    const myDataDir = "/Users/alice/.flair/data";
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(
      legacyPath,
      `<plist><dict><key>Label</key><string>${LEGACY_LAUNCHD_LABEL}</string><key>EnvironmentVariables</key><dict><key>ROOTPATH</key><string>${myDataDir}</string></dict></dict></plist>`,
    );
    const { run } = launchdStandIn();
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
    let result;
    try {
      result = cleanupLegacyLaunchdPlist(myDataDir, launchAgentsDir, run, undefined, { settleMs: 0, sleep: () => {} });
    } finally {
      console.log = origLog;
    }
    expect(result!.action).toBe("unloaded");
    expect(existsSync(legacyPath)).toBe(false);
    expect(logged.join("\n")).toContain("Retired the legacy launchd plist");
    expect(logged.join("\n")).not.toContain("✓");
  });

  test("cleanupLegacyLaunchdPlist: an owned legacy job that is NOT loaded is not booted out (no false 'failed to unload'), and the plist is still removed", () => {
    const myDataDir = "/Users/alice/.flair/data";
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(
      legacyPath,
      `<plist><dict><key>Label</key><string>${LEGACY_LAUNCHD_LABEL}</string><key>EnvironmentVariables</key><dict><key>ROOTPATH</key><string>${myDataDir}</string></dict></dict></plist>`,
    );
    const launchctlCalls: string[] = [];
    const result = cleanupLegacyLaunchdPlist(myDataDir, launchAgentsDir, (cmd) => {
      launchctlCalls.push(cmd);
      if (cmd.startsWith("launchctl print")) throw new Error("Could not find service");
    });
    expect(launchctlCalls).toEqual([`launchctl print ${GUI}/${LEGACY_LAUNCHD_LABEL}`]);
    expect(existsSync(legacyPath)).toBe(false);
    expect(result).toEqual({ action: "unloaded", deleteFailed: undefined });
  });

  test("cleanupLegacyLaunchdPlist: no legacy plist present is a clean no-op", () => {
    const myDataDir = "/Users/alice/.flair/data";
    const launchctlCalls: string[] = [];
    const result = cleanupLegacyLaunchdPlist(myDataDir, launchAgentsDir, (cmd) => {
      launchctlCalls.push(cmd);
    });

    expect(result.action).toBe("none");
    expect(launchctlCalls.length).toBe(0);
  });

  // ── flair#919: migration must not propagate a malformed plist ──────

  test("migrateLegacyLaunchdLabel: throws on a plist that does not contain the expected Label key", () => {
    // A plist that is valid XML but has a different label — the replace
    // won't match, and migration must refuse rather than write it unchanged.
    const wrongLabel = "com.example.something-else";
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, fakePlist(wrongLabel));

    const { calls, run } = launchdStandIn();
    expect(() => migrateLegacyLaunchdLabel(dataDir, run, launchAgentsDir))
      .toThrow(/does not contain the expected Label key/);
    // flair#2040: the plist is validated BEFORE anything is unloaded.
    expect(calls).toEqual([]);

    // The legacy plist must still exist — we did NOT delete it on failure.
    expect(existsSync(legacyPath)).toBe(true);
    // No new plist was written.
    const newLabel = launchdLabel(dataDir);
    expect(existsSync(launchdPlistPath(newLabel, launchAgentsDir))).toBe(false);
  });

  test("migrateLegacyLaunchdLabel: malformed XML that still carries the expected Label is REFUSED before anything is unloaded (flair#2040)", () => {
    // The Label replace matches, but the document is not a valid plist (the
    // <array> is never closed). Bootstrap would reject it only AFTER the legacy
    // job was booted out; the lint must refuse it first.
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    const malformed = fakePlist(LEGACY_LAUNCHD_LABEL).replace("  </array>\n", "");
    expect(malformed).toContain(`<key>Label</key><string>${LEGACY_LAUNCHD_LABEL}</string>`);
    expect(malformed).not.toContain("</array>");
    writeFileSync(legacyPath, malformed);

    // A host-independent stand-in for plutil -lint: rejects an unclosed <array>.
    const linted: string[] = [];
    const lint = (content: string) => {
      linted.push(content);
      const opened = (content.match(/<array>/g) ?? []).length;
      const closed = (content.match(/<\/array>/g) ?? []).length;
      return opened === closed ? null : "plutil -lint rejected the plist (<plist>: Encountered unexpected element)";
    };
    const { calls, run } = launchdStandIn();
    expect(() => migrateLegacyLaunchdLabel(dataDir, run, launchAgentsDir, undefined, { settleMs: 0, sleep: () => {}, lint }))
      .toThrow(/failed validation \(plutil -lint rejected the plist.*Nothing was unloaded/);

    // The REPLACEMENT content was linted (new label in, legacy label out) ...
    const newLabel = launchdLabel(dataDir);
    expect(linted.length).toBe(1);
    expect(linted[0]).toContain(`<key>Label</key><string>${newLabel}</string>`);
    // ... and NO launchctl call happened: no bootout, not even a presence probe.
    expect(calls).toEqual([]);
    expect(calls.some((c) => c.includes("bootout"))).toBe(false);
    // Nothing was written or removed.
    expect(readFileSync(legacyPath, "utf-8")).toBe(malformed);
    expect(existsSync(launchdPlistPath(newLabel, launchAgentsDir))).toBe(false);
  });

  test("migrateLegacyLaunchdLabel: the same plist, well-formed, passes the same lint and migrates (positive control for the refusal above)", () => {
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, fakePlist(LEGACY_LAUNCHD_LABEL));
    const lint = (content: string) =>
      (content.match(/<array>/g) ?? []).length === (content.match(/<\/array>/g) ?? []).length ? null : "rejected";
    const { calls, run } = launchdStandIn();
    const result = migrateLegacyLaunchdLabel(dataDir, run, launchAgentsDir, undefined, { settleMs: 0, sleep: () => {}, lint });
    expect(result.migrated).toBe(true);
    expect(calls).toContain(`launchctl bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
  });

  test("migrateLegacyLaunchdLabel: every refusal BEFORE the legacy bootout is a validation refusal; a legacy job that cannot be unloaded is not (flair#2040 r7)", () => {
    // The start paths boot nothing out after a validation refusal (nothing was
    // loaded or unloaded), and unload-and-verify after anything else — so the
    // two must be told apart by the error itself.
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    const refusal = (fn: () => unknown): unknown => {
      try { fn(); } catch (err) { return err; }
      throw new Error("expected a refusal");
    };
    const noLaunchctl = () => { throw new Error("no launchctl call is expected before validation passes"); };

    writeFileSync(legacyPath, fakePlist("com.example.something-else"));
    const wrongLabel = refusal(() => migrateLegacyLaunchdLabel(dataDir, noLaunchctl, launchAgentsDir));
    expect(isLaunchdValidationRefusal(wrongLabel)).toBe(true);

    writeFileSync(legacyPath, fakePlist(LEGACY_LAUNCHD_LABEL));
    const linted = refusal(() => migrateLegacyLaunchdLabel(dataDir, noLaunchctl, launchAgentsDir, undefined, { lint: () => "plutil -lint rejected the plist" }));
    expect(isLaunchdValidationRefusal(linted)).toBe(true);
    expect(String((linted as Error).message)).toContain("Nothing was unloaded");

    const unrunnable = refusal(() => migrateLegacyLaunchdLabel(dataDir, noLaunchctl, launchAgentsDir, undefined, { lint: () => "plutil -lint could not check the plist" }));
    expect(isLaunchdValidationRefusal(unrunnable)).toBe(true);

    // A plist that cannot be read (a directory in its place: EISDIR) is refused
    // the same way — nothing has been unloaded yet.
    rmSync(legacyPath);
    mkdirSync(legacyPath);
    const unreadable = refusal(() => migrateLegacyLaunchdLabel(dataDir, noLaunchctl, launchAgentsDir));
    expect(isLaunchdValidationRefusal(unreadable)).toBe(true);
    expect(String((unreadable as Error).message)).toContain("could not read the legacy plist");
    rmSync(legacyPath, { recursive: true });

    // Positive control: a legacy job that stays loaded after its bootout is a
    // failure AFTER an unload was attempted — not a validation refusal.
    writeFileSync(legacyPath, fakePlist(LEGACY_LAUNCHD_LABEL));
    const { run } = launchdStandIn({ bootoutSticks: false });
    const stuck = refusal(() => migrateLegacyLaunchdLabel(dataDir, run, launchAgentsDir, undefined, { settleMs: 0, sleep: () => {}, lint: () => null }));
    expect(String((stuck as Error).message)).toContain("the job is still loaded");
    expect(isLaunchdValidationRefusal(stuck)).toBe(false);
  });

  // ── flair#874 / flair#872 structural guards ────────────────────────

  test("stopFlairProcess uses launchctl unload, not launchctl stop, on the launchd path (flair#874)", async () => {
    const src = await Bun.file(join(import.meta.dirname, "..", "..", "src", "cli.ts")).text();
    // Find the stopFlairProcess function body.
    const fnStart = src.indexOf("async function stopFlairProcess");
    expect(fnStart).not.toBe(-1);
    // The next function after stopFlairProcess is startFlairProcess.
    const nextFn = src.indexOf("async function startFlairProcess", fnStart);
    expect(nextFn).not.toBe(-1);
    const fnBody = src.slice(fnStart, nextFn);

    // Must contain launchctl unload (the fix).
    expect(fnBody).toContain("launchctl unload");
    // Must NOT contain launchctl stop as a shell command (the old, broken
    // behaviour). The comment explaining the fix mentions "launchctl stop"
    // but no execSync/runLaunchctl call should invoke it.
    const cmdCalls = fnBody.match(/`launchctl \w+/g) ?? [];
    const stopCalls = cmdCalls.filter((c: string) => c.includes("stop"));
    expect(stopCalls.length).toBe(0);
  });

  test("migrateLegacyLaunchdLabel uses a function replacer, not a $-sensitive string replacement (flair#919)", async () => {
    const src = await Bun.file(join(import.meta.dirname, "..", "..", "src", "cli.ts")).text();
    // Find the migrateLegacyLaunchdLabel function body.
    const fnStart = src.indexOf("function migrateLegacyLaunchdLabel");
    expect(fnStart).not.toBe(-1);
    // The next function after migrateLegacyLaunchdLabel is cleanupLegacyLaunchdPlist.
    const nextFn = src.indexOf("function cleanupLegacyLaunchdPlist", fnStart);
    expect(nextFn).not.toBe(-1);
    const fnBody = src.slice(fnStart, nextFn);

    // Must use a function replacer (() => ...) to avoid $-sensitivity.
    expect(fnBody).toMatch(/\.replace\([^)]*,\s*\(\)\s*=>/);
    // Must NOT use a bare string as the second argument to .replace().
    // The only .replace call in this function should use the function form.
    const replaceCalls = fnBody.match(/\.replace\(/g) ?? [];
    expect(replaceCalls.length).toBe(1);
  });
});
