// flair-client.mjs is DENY-BY-DEFAULT about signing (flair#1855).
//
// The guard used to be keyed on a literal `SIGNING_ACTIONS` set — the actions
// that sign — while dispatch is a `switch`. That fails OPEN: a case added to the
// switch but forgotten from the set would sign with no identity at all. The guard
// is now inverted: every action requires an explicit identity UNLESS it is listed
// in `UNSIGNED`, which today is EMPTY. A new action is therefore signed-or-refused
// by construction; the only way to make one identity-less is to add it to
// UNSIGNED, deliberately.
//
// This test derives BOTH lists from the source (never a hand-written copy of the
// dispatch set) and runs EVERY action the dispatcher accepts:
//   - without an identity it must refuse, naming FLAIR_AGENT_ID / --agent; and
//   - with an identity it must pass the guard and reach the signing path (the key
//     load, which fails here because the temp home holds no key).
// The second assertion is what makes the test bite on a new switch case: a case
// that is added but not implemented (no flairFetch) refuses without an identity
// yet never reaches signing, so it fails. A test that only checked the refusal
// would pass for a stub that does nothing.

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "flair-client.mjs");
const SOURCE = readFileSync(SCRIPT, "utf8");

/** Every action the dispatcher accepts: the `case '<name>':` labels, minus default. */
function dispatchActions(): string[] {
  const out: string[] = [];
  for (const m of SOURCE.matchAll(/^\s*case\s+'([^']+)'\s*:/gm)) out.push(m[1]!);
  return out;
}

/** The explicit allow-list of actions that may run identity-less (parsed, not imported). */
function unsignedActions(): string[] {
  const block = SOURCE.match(/const\s+UNSIGNED\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!block) return [];
  return [...(block[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

const ACTIONS = dispatchActions();
const UNSIGNED = unsignedActions();

let emptyHome = "";
beforeAll(() => {
  emptyHome = mkdtempSync(join(tmpdir(), "flair-1855-"));
});
afterAll(() => {
  rmSync(emptyHome, { recursive: true, force: true });
});

async function runClient(action: string, extraEnv: Record<string, string> = {}) {
  // Built from scratch, never from process.env: a child that inherited a
  // developer's FLAIR_* deployment config could turn a missing identity into a
  // real signed request against a live host.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    FLAIR_KEY_DIR: emptyHome,
  };
  for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
  const proc = Bun.spawn(["node", SCRIPT, "memory", action, "arg1", "arg2"], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

describe("flair-client dispatch is deny-by-default about signing (flair#1855)", () => {
  it("derives both lists from the source (positive control)", () => {
    // A zero-length derivation would make every assertion below vacuous — the
    // exact failure mode (a check that enumerates nothing and reports green).
    expect(ACTIONS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
    // The allow-list is explicit and, today, empty. The DECLARATION is asserted,
    // not assumed: the guard must be keyed on an UNSIGNED allow-list at all (the
    // old code had no such thing, so this is the assertion that is red before the
    // inversion).
    expect(SOURCE).toMatch(/const\s+UNSIGNED\s*=\s*new\s+Set\s*\(/);
    expect(SOURCE).toMatch(/!UNSIGNED\.has\(action\)/);
    expect(UNSIGNED).toEqual([]);
  });

  it("an action with no decision yet is refused by default, not waved through", async () => {
    // Deny-by-default means an action the dispatcher does not know and that is not
    // in UNSIGNED is refused by the IDENTITY guard — not passed down to the switch
    // to fall through as `Unknown action`. This is the property the old
    // SIGNING_ACTIONS set lacked, so it is red on the pre-inversion code.
    const r = await runClient("frobnicate-not-a-dispatcher-action");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing to frobnicate-not-a-dispatcher-action");
    expect(r.stderr).toContain("FLAIR_AGENT_ID");
  });

  it("every UNSIGNED entry is a real dispatcher action (no stale exemption)", () => {
    for (const a of UNSIGNED) expect(ACTIONS).toContain(a);
  });

  it("every action either refuses without an identity or is explicitly UNSIGNED", async () => {
    for (const action of ACTIONS) {
      const unsigned = UNSIGNED.includes(action);
      const r = await runClient(action);
      if (unsigned) {
        // Exempt from the identity guard (there are none today).
        expect(r.stderr).not.toContain(`refusing to ${action}`);
      } else {
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain(`refusing to ${action}`);
        expect(r.stderr).toContain("FLAIR_AGENT_ID");
        expect(r.stderr).toContain("--agent");
        // Refused BEFORE the key load.
        expect(r.stderr).not.toContain("no private key found");
      }
    }
  });

  it("every signed action passes the guard and reaches the signing path with an identity", async () => {
    for (const action of ACTIONS) {
      if (UNSIGNED.includes(action)) continue;
      // Explicit identity, but the temp home holds no key: a real, implemented
      // action passes the guard and fails AT the key load, naming the agent. A
      // case added to the switch without signing anything never gets there.
      const r = await runClient(action, { FLAIR_AGENT_ID: "probe" });
      expect(r.stderr).not.toContain(`refusing to ${action}`);
      expect(r.stderr).toContain("no private key found for agent 'probe'");
    }
  });
});
