/**
 * flair#1684 review (F1) — the macOS launchd lane prints and uploads the
 * instance plist for diagnostics, and this repository is PUBLIC. In the window
 * between `flair init` (inline-secret plist, flair#1693) and `flair doctor
 * --fix` (pass-file launcher) that plist carries the admin password, so the
 * diagnostics path must redact it before it reaches the log or the artifact.
 *
 * These are the fails-first checks: on the pre-fix lane there was no redactor,
 * so a plist with an inline `<key>HDB_ADMIN_PASSWORD</key>` was copied and
 * `cat`ed verbatim. `redactPlist` must remove the value while leaving the
 * plist's structure (and the credential key, so the shape is still diagnosable)
 * intact.
 *
 * flair#1696 — the key list used to be hand-maintained and had already drifted
 * from the product's own `NEVER_GENERATED_SECRET_KEYS`: `FLAIR_ADMIN_PASS` and
 * four others were not covered. These tests pin the list to that export and
 * prove `--check`/`unredactedKeyNames` flag a surviving `FLAIR_ADMIN_PASS`
 * fixture (fails-first against the hand-maintained list).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NEVER_GENERATED_SECRET_KEYS } from "../../src/component-env.js";
import {
  REDACTED_KEYS,
  collectAdminPassSecrets,
  redactPlist,
  unredactedKeyNames,
} from "../../scripts/ci/redact-launchd-plist.mjs";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "ci", "redact-launchd-plist.mjs");

// A plist carrying the product's REAL name for the admin password. It was
// absent from the hand-maintained list, so it is the fails-first fixture for
// the drift this issue fixes.
const FLAIR_ADMIN_PASS_FIXTURE = `<dict>
  <key>FLAIR_ADMIN_PASS</key><string>fixture-pass-value</string>
</dict>`;

const INLINE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.tpsdev.flair.abcdef</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HDB_ADMIN_USERNAME</key><string>admin</string>
    <key>HDB_ADMIN_PASSWORD</key><string>s3cr3t-inline-value</string>
    <key>HTTP_PORT</key><string>9926</string>
  </dict>
  <key>KeepAlive</key><true/>
</dict>
</plist>`;

describe("redactPlist — inline credential plist", () => {
  test("removes the HDB_ADMIN_PASSWORD value from the one-line inline shape", () => {
    const out = redactPlist(INLINE_PLIST);
    expect(out).not.toContain("s3cr3t-inline-value");
    expect(out).toContain("<key>HDB_ADMIN_PASSWORD</key><string>REDACTED</string>");
  });

  test("keeps the credential key and the surrounding plist structure", () => {
    const out = redactPlist(INLINE_PLIST);
    // The key stays so the diagnostics still name the shape that leaked…
    for (const key of REDACTED_KEYS) {
      // …while no credential value survives.
      expect(out).not.toMatch(new RegExp(`<key>${key}</key>\\s*<string>(?!REDACTED)[^<]`));
    }
    expect(out).toContain("<key>Label</key><string>ai.tpsdev.flair.abcdef</string>");
    expect(out).toContain("<key>HTTP_PORT</key><string>9926</string>");
    expect(out).toContain("<key>KeepAlive</key><true/>");
  });

  test("redacts a key/string pair split across lines", () => {
    const pretty = `<dict>
  <key>HDB_ADMIN_PASSWORD</key>
  <string>multiline-secret</string>
</dict>`;
    const out = redactPlist(pretty);
    expect(out).not.toContain("multiline-secret");
    expect(out).toContain("REDACTED");
  });

  test("leaves the pass-file launcher shape untouched (no credential key)", () => {
    const launcher = `<dict>
  <key>ProgramArguments</key>
  <array>
    <string>/pkg/templates/launchd/start-flair-with-admin-pass.sh</string>
    <string>/Users/runner/.flair/admin-pass</string>
    <string>/opt/node</string>
    <string>/pkg/harper.js</string>
  </array>
</dict>`;
    expect(redactPlist(launcher)).toBe(launcher);
  });

  test("redacts admin-pass file contents passed as extra secrets", () => {
    const pass = "ZmFrZS1hZG1pbi1wYXNzLTEyMzQ1";
    const out = redactPlist(`<string>${pass}</string>`, [pass]);
    expect(out).not.toContain(pass);
    expect(out).toContain("REDACTED");
  });

  test("the CLI prints a redacted plist and never the inline secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-cli-"));
    try {
      const plist = join(dir, "ai.tpsdev.flair.deadbeef.plist");
      writeFileSync(plist, INLINE_PLIST);
      const run = spawnSync(process.execPath, [SCRIPT, plist], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("s3cr3t-inline-value");
      expect(run.stdout).toContain("<key>HDB_ADMIN_PASSWORD</key><string>REDACTED</string>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("REDACTED_KEYS — derived, not hand-maintained (flair#1696)", () => {
  test("covers every key the product says must never carry a generated secret", () => {
    // The load-bearing drift guard: importing the product export means a key
    // added to src/component-env.ts fails THIS test until the redactor covers
    // it. There is deliberately no copy of the list here or in the redactor.
    for (const key of NEVER_GENERATED_SECRET_KEYS) {
      expect(REDACTED_KEYS).toContain(key);
    }
  });

  test("also covers the launchd-only FLAIR_TOKEN credential", () => {
    expect(REDACTED_KEYS).toContain("FLAIR_TOKEN");
  });
});

describe("unredactedKeyNames — the artifact/log assertion (flair#1696)", () => {
  test("names each credential key still carrying a non-REDACTED value", () => {
    const plist = `<dict>
  <key>FLAIR_ADMIN_PASS</key><string>fixture-pass-value</string>
  <key>FLAIR_TOKEN</key><string>fixture-token-value</string>
  <key>HDB_ADMIN_PASSWORD</key><string>REDACTED</string>
</dict>`;
    expect(unredactedKeyNames(plist)).toEqual(["FLAIR_ADMIN_PASS", "FLAIR_TOKEN"]);
  });

  test("reports nothing once redactPlist has run", () => {
    expect(unredactedKeyNames(redactPlist(INLINE_PLIST))).toEqual([]);
  });
});

describe("redactPlist — product secret names (flair#1696)", () => {
  test("redacts a FLAIR_ADMIN_PASS inline value", () => {
    const out = redactPlist(FLAIR_ADMIN_PASS_FIXTURE);
    expect(out).not.toContain("fixture-pass-value");
    expect(out).toContain("<key>FLAIR_ADMIN_PASS</key><string>REDACTED</string>");
  });
});

describe("--check — fails on a surviving credential key, names it not its value", () => {
  test("exits 1 on the FLAIR_ADMIN_PASS fails-first fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-check-bad-"));
    try {
      writeFileSync(join(dir, "fixture.plist"), FLAIR_ADMIN_PASS_FIXTURE);
      const run = spawnSync(process.execPath, [SCRIPT, "--check", dir], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("FLAIR_ADMIN_PASS");
      expect(run.stderr).not.toContain("fixture-pass-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits 0 on a redacted artifact directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-check-ok-"));
    try {
      writeFileSync(join(dir, "redacted.plist"), redactPlist(INLINE_PLIST));
      const run = spawnSync(process.execPath, [SCRIPT, "--check", dir], { encoding: "utf8" });
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectAdminPassSecrets", () => {
  test("reads and trims the admin-pass file when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-pass-"));
    try {
      const passFile = join(dir, "admin-pass");
      writeFileSync(passFile, "  file-secret-value\n", { mode: 0o600 });
      expect(collectAdminPassSecrets([passFile])).toEqual(["file-secret-value"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns no secrets when the file is absent (never throws)", () => {
    expect(collectAdminPassSecrets([join(tmpdir(), "does-not-exist-redact-pass")])).toEqual([]);
  });
});
