/**
 * flair#1822 — no shipped agent-identity default anywhere under scripts/.
 *
 * A default identity is a trust anchor by omission: an invocation that forgets
 * its env var acts as a specific principal, and on a host holding that
 * principal's key the write (or read) goes out as the wrong author
 * (flair#1816). This is the grep-level guard that keeps one from coming back.
 *
 * It scans every code file under scripts/ for a quoted agent id used as a value
 * (`|| 'flint'`, `?? "flint"`, `= 'flint'`) or an identity env assignment
 * (`TPS_AGENT_ID=flint`). Comment lines are skipped (historical prose), and any
 * remaining exception must be listed in ALLOWLIST with a reason.
 *
 * RED before the change: on origin/main the same scan finds six offending lines
 * across six files (flair-bootstrap, flair-sync, flair-sync-soul,
 * migrate-memories, flair-activity, harper-watchdog).
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPTS = join(ROOT, "scripts");

/** Code-file extensions a default identity could hide in. */
const CODE_EXT = /\.(mjs|js|cjs|ts|sh|bash|py)$/;

/**
 * Explicit exceptions: `path` (repo-relative) plus the exact `line` text and a
 * `reason`. Empty today — every remaining mention is a comment line (skipped
 * below), the guard itself, or the shared helper's doc.
 */
const ALLOWLIST: Array<{ path: string; line: string; reason: string }> = [];

/** A line that is entirely a comment in one of the languages under scripts/. */
function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("<!--") ||
    trimmed.startsWith('"""') ||
    trimmed.startsWith("'''")
  );
}

/**
 * Patterns for identity-SETTING SYNTAX, not for a list of agent names. A guard
 * keyed on the names it has seen is a blacklist: a default under a new id slips
 * through. These match the SHAPE — an identity constant falling back to a string
 * literal, a literal assigned to `AGENT_ID`/`agentId` or an `agent:` field, and
 * a literal `TPS_AGENT_ID=`/`FLAIR_AGENT_ID=` shell assignment — without naming
 * any agent.
 */
const OFFENDER = [
  // `AGENT_ID ... || '<literal>'` / `agentId ... ?? "<literal>"` — env fallback to a literal
  /\b(?:AGENT_ID|agentId)\b[^\n;]*?(?:\|\||\?\?)\s*['"][A-Za-z][A-Za-z0-9_-]*['"]/,
  // `AGENT_ID = '<literal>'` / `agentId = "<literal>"` — literal assignment
  /\b(?:AGENT_ID|agentId)\s*[:=]\s*['"][A-Za-z][A-Za-z0-9_-]*['"]/,
  // `agentId: '<literal>'` — identity field set to a bare literal
  /\bagentId\s*:\s*['"][A-Za-z][A-Za-z0-9_-]*['"]/,
  // shell: `TPS_AGENT_ID=<literal>` / `FLAIR_AGENT_ID=<literal>` (unquoted literal)
  /\b(?:TPS_AGENT_ID|FLAIR_AGENT_ID)=[A-Za-z][A-Za-z0-9_-]*/,
];

/** True when `text` carries identity-setting syntax. Exposed for the tests. */
function matchesAny(text: string): boolean {
  return OFFENDER.some((re) => re.test(text));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return CODE_EXT.test(e.name) ? [p] : [];
  });
}

interface Offender {
  path: string;
  line: number;
  text: string;
}

function scan(): Offender[] {
  const found: Offender[] = [];
  for (const file of walk(SCRIPTS)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((raw, i) => {
      const trimmed = raw.trim();
      if (isCommentLine(trimmed)) return;
      if (!matchesAny(raw)) return;
      if (ALLOWLIST.some((a) => a.path === rel && a.line === trimmed)) return;
      found.push({ path: rel, line: i + 1, text: trimmed });
    });
  }
  return found;
}

describe("scripts/ ships no default agent identity (flair#1822)", () => {
  test("no literal agent id is used as a default identity", () => {
    const offenders = scan();
    const detail = offenders.map((o) => `${o.path}:${o.line}: ${o.text}`).join("\n");
    expect(offenders, `found ${offenders.length} shipped identity default(s):\n${detail}`).toEqual([]);
  });

  test("the scan actually traverses the scripts tree (guard the guard)", () => {
    const files = walk(SCRIPTS).map((f) => relative(ROOT, f));
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("scripts/lib/agent-identity.mjs");
  });

  test("the SHAPE of an identity default is caught, not just known names (guard the guard)", () => {
    const planted = [
      `const AGENT_ID = process.env.FLAIR_AGENT_ID || "another-agent";`, // env fallback to a literal
      `const agentId = get("--agent") ?? "another-agent";`, // nullish fallback to a literal
      `const AGENT_ID = "another-agent";`, // direct literal assignment
      `const body = { agentId: "another-agent" };`, // identity field
      `const body = { agentId: 'another-agent' };`, // identity field
      `TPS_AGENT_ID=another-agent tps mail send x y`, // shell assignment
      `FLAIR_AGENT_ID=another-agent node scripts/x.mjs`, // shell assignment
    ];
    for (const line of planted) {
      expect(matchesAny(line), `not caught: ${line}`).toBe(true);
    }
  });
});
