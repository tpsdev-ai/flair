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
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NEVER_GENERATED_SECRET_KEYS } from "../../src/component-env.js";
import {
  REDACTED_KEYS,
  REPORT_SCHEMA,
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
      // …with REDACTED as the string value.
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
  test("covers every credential key excluded from generated component .env files", () => {
    // Pins that the redactor covers every key the product export names; there
    // is deliberately no copy of the list here or in the redactor.
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

describe("--check — flags supported credential key/string pairs with non-REDACTED values", () => {
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

describe("--check publishes findings on its own report channel (flair#2589)", () => {
  const fixtures = join(import.meta.dir, "..", "..", "scripts", "ci", "redact-fixtures");

  test("--check without a target exits 2 with a named usage error", () => {
    const run = spawnSync("node", [SCRIPT, "--check"], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("redact-launchd-plist: usage error: --check requires at least one target path");
  });

  test("--check without a target leaves the report untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-report-no-target-"));
    try {
      const report = join(dir, "report.json");
      writeFileSync(report, "SENTINEL");
      const run = spawnSync("node", [SCRIPT, "--check", "--report", report], { encoding: "utf8" });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("usage error: --check requires at least one target path");
      expect(readFileSync(report, "utf8")).toBe("SENTINEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a clean scan writes an empty-findings report and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-report-clean-"));
    try {
      const report = join(dir, "report.json");
      const run = spawnSync(process.execPath, [SCRIPT, "--check", "--report", report, join(fixtures, "clean")], {
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      const doc = JSON.parse(readFileSync(report, "utf8"));
      expect(doc.schema).toBe(REPORT_SCHEMA);
      expect(doc.findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a finding is written to the report, naming the key and not the value", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-report-leaky-"));
    try {
      const report = join(dir, "report.json");
      const run = spawnSync(process.execPath, [SCRIPT, "--check", "--report", report, join(fixtures, "leaky")], {
        encoding: "utf8",
      });
      expect(run.status).toBe(1);
      const doc = JSON.parse(readFileSync(report, "utf8"));
      expect(doc.findings).toHaveLength(1);
      expect(doc.findings[0].keys).toEqual(["HDB_ADMIN_PASSWORD"]);
      expect(readFileSync(report, "utf8")).not.toContain("example-placeholder-not-a-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a check that could not run leaves the report untouched", () => {
    // The report is written only when the scan finishes. On a target that
    // cannot be read the scanner exits 2 and writes nothing, so a caller that
    // finds no finding record there falls back to could-not-run.
    const dir = mkdtempSync(join(tmpdir(), "redact-report-missing-"));
    try {
      const report = join(dir, "report.json");
      writeFileSync(report, "SENTINEL");
      const run = spawnSync(process.execPath, [SCRIPT, "--check", "--report", report, join(dir, "no-such-target")], {
        encoding: "utf8",
      });
      expect(run.status).toBe(2);
      expect(readFileSync(report, "utf8")).toBe("SENTINEL");
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

// flair#2589 — the check must load in the form the lane has. The lane invokes
// it with plain `node` (not bun), and src/component-env.ts imports a `.js`
// specifier that only the compiled dist/ has, so a load of the source tree
// failed with ERR_MODULE_NOT_FOUND before scanning anything. These spawn
// `node` explicitly to pin that the check loads and runs without a build.
const NODE = "node";
const FIXTURES = join(import.meta.dir, "..", "..", "scripts", "ci", "redact-fixtures");

describe("the fixtures run on every PR targeting main (flair#2589)", () => {
  test("a clean (redacted) fixture passes under plain node", () => {
    const run = spawnSync(NODE, [SCRIPT, "--check", join(FIXTURES, "clean")], { encoding: "utf8" });
    expect(run.status).toBe(0);
  });

  test("a credential key with a non-REDACTED value is a finding: exit 1, key named, value not printed", () => {
    const run = spawnSync(NODE, [SCRIPT, "--check", join(FIXTURES, "leaky")], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("HDB_ADMIN_PASSWORD");
    expect(run.stderr).not.toContain("example-placeholder-not-a-secret");
  });
});

describe("--check reports a crash as a crash, distinct from a finding (flair#2589)", () => {
  test("a check that cannot load its key list exits 2 with a named message", () => {
    // The script's key list is a relative import. A copy with no such sibling
    // cannot load it — the same shape the lane hit — and that must be exit 2,
    // not exit 1 (a finding) and never 0.
    const dir = mkdtempSync(join(tmpdir(), "redact-crash-"));
    try {
      const copy = join(dir, "redact-launchd-plist.mjs");
      copyFileSync(SCRIPT, copy);
      const run = spawnSync(NODE, [copy, "--check", dir], { encoding: "utf8", timeout: 30_000 });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("redaction check could not run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("--check on a named target that cannot be read exits 2, never 0 (flair#2589)", () => {
  test("a named target that does not exist exits 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-check-missing-"));
    try {
      const run = spawnSync(NODE, [SCRIPT, "--check", join(dir, "no-such-target")], { encoding: "utf8" });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("cannot read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a named target that cannot be read exits 2", () => {
    // A self-referential symlink cannot be statted for ANY uid, so this fails
    // for root too. CI's Docker jobs run as root, where a mode-based unreadable
    // case (chmod 000) is ignored and would prove nothing.
    const dir = mkdtempSync(join(tmpdir(), "redact-check-unreadable-"));
    try {
      const target = join(dir, "loop");
      symlinkSync("loop", target);
      const run = spawnSync(NODE, [SCRIPT, "--check", target], { encoding: "utf8" });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("cannot read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a missing or malformed key-list export is a crash, not a finding (flair#2589)", () => {
  // The real scanner, but the dependency-free module it imports exports the
  // wrong thing. That must be exit 2 (could not run): before the guard, a
  // missing export threw at module load (Node exits 1, which a caller that
  // reads exit status alone would take as a finding) and a non-array export
  // spread silently (wrong keys, exit 0).
  function runWithExported(source: string) {
    const dir = mkdtempSync(join(tmpdir(), "redact-export-"));
    try {
      const ci = join(dir, "scripts", "ci");
      const lib = join(dir, "src", "lib");
      mkdirSync(ci, { recursive: true });
      mkdirSync(lib, { recursive: true });
      copyFileSync(SCRIPT, join(ci, "redact-launchd-plist.mjs"));
      writeFileSync(join(lib, "secret-keys.ts"), source);
      const run = spawnSync(NODE, [join(ci, "redact-launchd-plist.mjs"), "--check", dir], {
        encoding: "utf8",
        timeout: 30_000,
      });
      return run;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a missing export exits 2, not 1", () => {
    const run = runWithExported("export const SOMETHING_ELSE = 1;\n");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("redaction check could not run");
  });

  test("a non-array export exits 2, not 0", () => {
    const run = runWithExported('export const NEVER_GENERATED_SECRET_KEYS = "not-an-array";\n');
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("redaction check could not run");
  });

  test("an array with a non-string or empty element exits 2, not 0", () => {
    // Array.isArray alone accepts this, and a null element would build a key
    // pattern that matches nothing.
    const run = runWithExported(
      'export const NEVER_GENERATED_SECRET_KEYS = ["HDB_ADMIN_PASSWORD", null, ""];\n',
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("redaction check could not run");
  });

  test("a key list whose construction throws exits 2, not 0", () => {
    // A Proxy over an array passes Array.isArray but throws when the list is
    // spread into REDACTED_KEYS; that construction failure must be a crash.
    const run = runWithExported(
      'export const NEVER_GENERATED_SECRET_KEYS = new Proxy(["HDB_ADMIN_PASSWORD"], {\n' +
        "  get(target, prop, receiver) {\n" +
        '    if (prop === Symbol.iterator) throw new Error("no iterator");\n' +
        "    return Reflect.get(target, prop, receiver);\n" +
        "  },\n" +
        "});\n",
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("redaction check could not run");
  });
});
