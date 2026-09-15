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
 *   node redact-launchd-plist.mjs --check <path>...
 *                                              # assert no credential key
 *                                              # survives with a value
 *
 * Exit codes: 0 on success, 2 when a named file cannot be read. A diagnostics
 * redactor must not fail the dump it is cleaning, so read failures are loud but
 * do not abort the caller's remaining output. `--check` exits 1 on a finding:
 * that path is an assertion, so it must fail the caller.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The product's authoritative "key names that must never carry a secret" list
// (src/component-env.ts). Importing it instead of copying it is the point: a
// key added to the product list is covered here in the same change, and the
// unit test fails if this export and `REDACTED_KEYS` ever drift apart.
// `FLAIR_TOKEN` is the one credential name the launchd dump can carry that is
// not a component `.env` secret, so it is appended rather than assumed.
import { NEVER_GENERATED_SECRET_KEYS } from "../../src/component-env.ts";

/**
 * Credential `<key>`s that must never appear with their value in a plist we
 * print or upload. Derived from the product export plus `FLAIR_TOKEN`; a key
 * is deduplicated so the product list gaining `FLAIR_TOKEN` later is a no-op.
 */
export const REDACTED_KEYS = [...new Set([...NEVER_GENERATED_SECRET_KEYS, "FLAIR_TOKEN"])];

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

/** Every regular file at or under `path` (a file yields itself). */
function filesUnder(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    return entry.isFile() ? [child] : [];
  });
}

/** Assert that no credential key survives with a value under `paths`. */
function checkPaths(paths) {
  const targets = paths.flatMap(filesUnder);
  let findings = 0;
  for (const file of targets) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const keys = unredactedKeyNames(text);
    if (keys.length > 0) {
      findings += keys.length;
      console.error(`redact-launchd-plist: unredacted credential key(s) in ${file}: ${keys.join(", ")}`);
    }
  }
  return findings > 0 ? 1 : 0;
}

/**
 * Redact every named file (or stdin when none are named) to stdout; `--check`
 * instead asserts the named files/directories carry no unredacted credential.
 */
export function main(argv = process.argv.slice(2)) {
  let failed = false;
  if (argv[0] === "--check") {
    return checkPaths(argv.slice(1));
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
  process.exit(main());
}
