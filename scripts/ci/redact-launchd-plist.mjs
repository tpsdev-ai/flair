#!/usr/bin/env node
/**
 * redact-launchd-plist.mjs — strip inline credentials from a launchd plist
 * before it is printed to the CI log or copied into the diagnostics artifact
 * (flair#1684 review, F1).
 *
 * WHY THIS EXISTS. The diagnostics dump in the macOS launchd lane `cat`s and
 * `cp`s every plist under ~/Library/LaunchAgents, and the pass-file-missing
 * check `cat`s them too. In the window between `flair init` (which may write
 * the inline-secret plist, flair#1693) and `flair doctor --fix` (which rewrites
 * it to the pass-file launcher) the plist carries `<key>HDB_ADMIN_PASSWORD</key>
 * <string>…</string>`. This repository is PUBLIC, so a raw `cat` or artifact
 * `cp` in that window publishes the credential. Redact on the way out; never
 * print the raw bytes.
 *
 * WHAT IT DOES. Replaces the `<string>` value that follows each credential
 * `<key>` with `REDACTED`, tolerating whitespace/newlines between the key and
 * its string. It also redacts the literal contents of the admin-pass file
 * (`~/.flair/admin-pass`, or `FLAIR_ADMIN_PASS_FILE`) anywhere it appears, so a
 * plist that carries the secret outside the key/string shape is still covered.
 *
 * Usage:
 *   node redact-launchd-plist.mjs <file>...    # redacted plist(s) to stdout
 *   cat plist | node redact-launchd-plist.mjs  # redacted plist to stdout
 *   node redact-launchd-plist.mjs --check [--report <file>] <path>...
 *                                              # assert no credential key
 *                                              # survives with a value other
 *                                              # than REDACTED; with
 *                                              # --report, write the findings
 *                                              # to <file> as JSON
 *
 * When `--report` is supplied, completed scans write finding records as JSON.
 * The shared helper pairs scanner status and report: exit 0 needs a valid
 * empty-findings report; exit 1 needs a valid non-empty report. Other outcomes,
 * including Node startup exit 1 without a report, are could-not-run.
 *
 * Handled exits: 0 for success, 1 for check findings, 2 for usage, read,
 * report-write or handled startup errors. Finding lines go to stderr.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Credential keys Flair must not add to component `.env` files.
// Importing it instead of copying it is the point: a key added to the product
// list is covered here in the same change, with no second list in this file to
// drift from it. `FLAIR_TOKEN` is the one credential name the launchd dump can
// carry that is not a component `.env` secret, so it is appended rather than
// assumed.
//
// The list lives in src/lib/secret-keys.ts, a module with NO imports. A plain
// `node` load of src/component-env.ts (which imports a `.js` specifier that only
// the compiled output has) used to fail with ERR_MODULE_NOT_FOUND, so the check
// could not run at all (flair#2589). The dynamic import lets a load failure be
// reported as a crash (exit 2), distinct from a scan finding (exit 1).
let NEVER_GENERATED_SECRET_KEYS;
let REDACTED_KEYS;
try {
  ({ NEVER_GENERATED_SECRET_KEYS } = await import("../../src/lib/secret-keys.ts"));
  // Validate and construct the key list inside the handled path. A missing or
  // non-array export, an element that is not a non-empty string, or a spread
  // that throws must all be a crash (exit 2) — never a silent wrong key list
  // (exit 0) or a module-load throw Node exits 1 for (flair#2589).
  if (!Array.isArray(NEVER_GENERATED_SECRET_KEYS)) {
    throw new TypeError("NEVER_GENERATED_SECRET_KEYS is not an array");
  }
  for (let i = 0; i < NEVER_GENERATED_SECRET_KEYS.length; i += 1) {
    const key = NEVER_GENERATED_SECRET_KEYS[i];
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError(`NEVER_GENERATED_SECRET_KEYS[${i}] is not a non-empty string`);
    }
  }
  REDACTED_KEYS = [...new Set([...NEVER_GENERATED_SECRET_KEYS, "FLAIR_TOKEN"])];
} catch (err) {
  console.error(`redact-launchd-plist: redaction check could not run: ${err?.message ?? err}`);
  process.exit(2);
}

/**
 * Credential `<key>`s that must never appear with their value in a plist we
 * print or upload. Derived from the product export plus `FLAIR_TOKEN`; a key
 * is deduplicated so the product list gaining `FLAIR_TOKEN` later is a no-op.
 */
export { REDACTED_KEYS };

/** Where the admin-pass file is expected to live. */
export function adminPassFileCandidates(env = process.env) {
  return [env.FLAIR_ADMIN_PASS_FILE, join(homedir(), ".flair", "admin-pass")].filter(
    (p) => typeof p === "string" && p.length > 0,
  );
}

/**
 * Read the admin-pass file contents (trimmed) so the literal value can be
 * redacted anywhere it appears. Returns `[]` when no file is present; never
 * throws.
 */
export function collectAdminPassSecrets(paths = adminPassFileCandidates()) {
  const secrets = [];
  for (const path of paths) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) secrets.push(value);
    } catch {
      /* absent/unreadable is fine — nothing to redact */
    }
  }
  return secrets;
}

/**
 * Redact credential values from a plist string. Pure: callers pass any extra
 * literal secrets (e.g. the admin-pass contents) to redact as well.
 */
export function redactPlist(text, extraSecrets = []) {
  let out = String(text ?? "");
  for (const key of REDACTED_KEYS) {
    // `[\s\S]*?` stops at the first `</string>`; plist values are XML-escaped,
    // so a literal `<` cannot appear inside one. The key/string pair can be on
    // one line (the flair#1693 inline shape) or split across lines.
    const re = new RegExp(`(<key>\\s*${key}\\s*</key>\\s*<string>)[\\s\\S]*?(</string>)`, "g");
    out = out.replace(re, (_match, before, after) => `${before}REDACTED${after}`);
  }
  for (const secret of extraSecrets) {
    if (typeof secret === "string" && secret.length > 0) {
      out = out.split(secret).join("REDACTED");
    }
  }
  return out;
}

/**
 * Names of credential `<key>`s that still carry a value other than `REDACTED`
 * in `text`. Returns NAMES only — never the value — so a caller can report a
 * finding without re-leaking it.
 */
export function unredactedKeyNames(text) {
  const input = String(text ?? "");
  const found = [];
  for (const key of REDACTED_KEYS) {
    const re = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`, "g");
    let match;
    while ((match = re.exec(input)) !== null) {
      if (match[1].trim() !== "REDACTED" && !found.includes(key)) found.push(key);
    }
  }
  return found;
}

/**
 * Every regular file at or under `path` (a file yields itself). Throws when
 * `path` cannot be statted: a named target that is missing or unreadable must
 * make `--check` exit 2, never report an unscanned target as clean (flair#2589).
 */
function filesUnder(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    return entry.isFile() ? [child] : [];
  });
}

/** Schema tag for completed `--check` reports. */
export const REPORT_SCHEMA = "redact-launchd-plist/report/1";

/** Write the `--check` finding records to `reportPath`. Returns true on success. */
function writeReport(reportPath, findings) {
  try {
    writeFileSync(reportPath, `${JSON.stringify({ schema: REPORT_SCHEMA, findings })}\n`);
    return true;
  } catch (err) {
    console.error(`redact-launchd-plist: cannot write report ${reportPath}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Assert that no supported credential key/string pair under `paths` has a
 * value other than `REDACTED`. With `reportPath`, write the finding records
 * there when the scan finishes so a caller can validate the exit code.
 */
function checkPaths(paths, reportPath) {
  const findings = [];
  for (const path of paths) {
    // A named target that cannot be read is a check that could not run (exit 2),
    // not a clean result: reporting an unscanned target as clean is the failure
    // this assertion exists to catch (flair#2589).
    let targets;
    try {
      targets = filesUnder(path);
    } catch (err) {
      console.error(`redact-launchd-plist: cannot read ${path}: ${err?.message ?? err}`);
      return 2;
    }
    for (const file of targets) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        console.error(`redact-launchd-plist: cannot read ${file}: ${err?.message ?? err}`);
        return 2;
      }
      const keys = unredactedKeyNames(text);
      if (keys.length > 0) {
        findings.push({ file, keys });
        console.error(`redact-launchd-plist: unredacted credential key(s) in ${file}: ${keys.join(", ")}`);
      }
    }
  }
  // Written only when the scan finishes (exit 0 or 1). A write failure is
  // could-not-run: the caller classifies on this channel, so a finding it cannot
  // read there must never be reported as one (flair#2589).
  if (reportPath !== undefined && !writeReport(reportPath, findings)) {
    return 2;
  }
  return findings.length > 0 ? 1 : 0;
}

/**
 * Redact every named file (or stdin when none are named) to stdout; `--check`
 * instead checks supported credential key/string pairs in named files/directories
 * and, when `--report <file>` is given, writes the finding records there.
 */
export function main(argv = process.argv.slice(2)) {
  let failed = false;
  let reportPath;
  const reportAt = argv.indexOf("--report");
  if (reportAt !== -1) {
    reportPath = argv[reportAt + 1];
    if (typeof reportPath !== "string" || reportPath.length === 0) {
      console.error("redact-launchd-plist: --report needs a file path");
      return 2;
    }
    argv = [...argv.slice(0, reportAt), ...argv.slice(reportAt + 2)];
  }
  if (argv[0] === "--check") {
    if (argv.length === 1) {
      console.error("redact-launchd-plist: usage error: --check requires at least one target path");
      return 2;
    }
    return checkPaths(argv.slice(1), reportPath);
  }
  const secrets = collectAdminPassSecrets();
  if (argv.length === 0) {
    const input = readFileSync(0, "utf8");
    process.stdout.write(redactPlist(input, secrets));
    return 0;
  }
  for (const path of argv) {
    try {
      process.stdout.write(redactPlist(readFileSync(path, "utf8"), secrets));
    } catch (err) {
      failed = true;
      console.error(`redact-launchd-plist: cannot read ${path}: ${err?.message ?? err}`);
    }
  }
  return failed ? 2 : 0;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  let code;
  try {
    code = main();
  } catch (err) {
    // An unexpected throw is a crash, not a scan result: exit 2 so the caller can
    // tell it apart from a finding (exit 1). Never a silent pass.
    console.error(`redact-launchd-plist: redaction check could not run: ${err?.message ?? err}`);
    code = 2;
  }
  process.exit(code);
}
