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
  resolveLaunchdLabel,
  migrateLegacyLaunchdLabel,
  ensureLaunchdServiceLoaded,
} from "../../src/cli.ts";

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

    const calls: string[] = [];
    const result = migrateLegacyLaunchdLabel(dataDir, (cmd) => calls.push(cmd), launchAgentsDir);

    const newLabel = launchdLabel(dataDir);
    expect(result.migrated).toBe(true);
    expect(result.label).toBe(newLabel);

    // Call order: exactly one launchctl call, and it's the unload of the LEGACY plist.
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("launchctl unload");
    expect(calls[0]).toContain(legacyPath);

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

  test("ensureLaunchdServiceLoaded on a legacy install: unload legacy BEFORE load/start under the new label (call order)", () => {
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
    writeFileSync(legacyPath, fakePlist(LEGACY_LAUNCHD_LABEL));

    const calls: string[] = [];
    const result = ensureLaunchdServiceLoaded(dataDir, (cmd) => calls.push(cmd), launchAgentsDir);

    const newLabel = launchdLabel(dataDir);
    expect(result.migrated).toBe(true);
    expect(result.label).toBe(newLabel);

    // Exactly 3 launchctl calls, in this order: unload legacy, load new, start new.
    expect(calls.length).toBe(3);
    expect(calls[0]).toContain("launchctl unload");
    expect(calls[0]).toContain(legacyPath);
    expect(calls[1]).toContain("launchctl load");
    expect(calls[1]).toContain(launchdPlistPath(newLabel, launchAgentsDir));
    expect(calls[2]).toBe(`launchctl start ${newLabel}`);

    // There is never a moment with both registered: legacy file is gone,
    // new one exists, by the time this returns.
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(launchdPlistPath(newLabel, launchAgentsDir))).toBe(true);
  });

  test("ensureLaunchdServiceLoaded on an already-current install: no migration, just load then start", () => {
    const newLabel = launchdLabel(dataDir);
    writeFileSync(launchdPlistPath(newLabel, launchAgentsDir), fakePlist(newLabel));

    const calls: string[] = [];
    const result = ensureLaunchdServiceLoaded(dataDir, (cmd) => calls.push(cmd), launchAgentsDir);

    expect(result.migrated).toBe(false);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("launchctl load");
    expect(calls[1]).toBe(`launchctl start ${newLabel}`);
  });

  test("ensureLaunchdServiceLoaded tolerates a load failure but propagates a start failure", () => {
    const newLabel = launchdLabel(dataDir);
    writeFileSync(launchdPlistPath(newLabel, launchAgentsDir), fakePlist(newLabel));

    const calls: string[] = [];
    const runLaunchctl = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("launchctl load")) throw new Error("service already loaded");
      if (cmd.includes("launchctl start")) throw new Error("could not find service");
    };

    expect(() => ensureLaunchdServiceLoaded(dataDir, runLaunchctl, launchAgentsDir)).toThrow("could not find service");
    // Both were attempted (load's failure didn't block the start attempt)
    expect(calls.length).toBe(2);
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
});
