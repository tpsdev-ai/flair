import { describe, test, expect, afterEach } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isProbeMode } from "../src/session-start-hook.ts";

/**
 * flair#1007 — probe mode.
 *
 * `flair doctor` needs to answer "does the command registered in the harness
 * settings still resolve and execute?" without the side effects of a real run
 * (a bootstrap read and a presence write). FLAIR_HOOK_PROBE makes this binary
 * answer that and nothing else: print the inert payload, exit 0, before stdin
 * is read or any client exists.
 *
 * The predicate is unit-tested directly; the short-circuit is tested by
 * SPAWNING the entry point as its own process, because "it returns before
 * constructing a client" is a property of main(), not of an exported function.
 */

const NOOP = "{}";
/**
 * The hook's ENTRY POINT, spawned as its own process — deliberately the
 * SOURCE, not dist/.
 *
 * The CI lane that runs this suite (`cd packages/flair-mcp && bun test`)
 * builds @tpsdev-ai/flair-client, because the hook imports it by its built
 * dist — but it never builds THIS package. dist/ is nonetheless usually
 * present, because a sibling file (mcp-node-preflight.test.ts) runs
 * `npm run build` from its own `beforeAll` when the shim is missing. That
 * makes dist/ an artifact of which test file bun happens to reach first, not
 * something this lane guarantees: targeting it here failed on all four Node
 * legs while passing locally, where a previous build had left dist/ behind.
 *
 * Copying that build-if-absent hook here would trade the ordering dependency
 * for a second `tsc` invocation racing the first, to gain nothing: the
 * property under test is the short-circuit at the top of main(), and the
 * --noCheck build is a straight transpile of it. Whether the shipped artifact
 * is well-formed is a different question, already asked by
 * mcp-node-preflight.test.ts and by the pack-smoke lane.
 *
 * The existence assertion below is kept as a hard failure rather than a skip:
 * if this path is ever wrong, that must be loud.
 */
const ENTRY = join(import.meta.dir, "..", "src", "session-start-hook.ts");

/**
 * flair#1796 — describe a child that overran its OWN deadline, with what it
 * produced, so the leg that was slow is named rather than reported as a bare
 * test timeout.
 */
function childOverranDeadline(leg: string, deadlineMs: number, r: SpawnSyncReturns<string>): string {
  const outcome =
    r.signal !== null
      ? `did not exit within ${deadlineMs} ms`
      : `exited early with status ${r.status} (signal ${r.signal})`;
  return `hook entry point (${leg} leg) ${outcome}; stdout/stderr so far: ${JSON.stringify({
    stdout: r.stdout,
    stderr: r.stderr,
  })}`;
}

const ORIGINAL_AGENT_ID = process.env.FLAIR_AGENT_ID;
afterEach(() => {
  if (ORIGINAL_AGENT_ID === undefined) delete process.env.FLAIR_AGENT_ID;
  else process.env.FLAIR_AGENT_ID = ORIGINAL_AGENT_ID;
});

describe("isProbeMode", () => {
  test("any non-empty value other than '0' enables it", () => {
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "1" })).toBe(true);
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "true" })).toBe(true);
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "yes" })).toBe(true);
  });

  test("unset, empty or '0' leaves the hook in normal mode", () => {
    // An accidentally-empty variable must not silently disable ambient memory.
    expect(isProbeMode({})).toBe(false);
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "" })).toBe(false);
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "0" })).toBe(false);
  });
});

describe("probe mode short-circuits the whole hook (spawned entry point)", () => {
  // flair#1796: the case below spends a FIXED ~3 s blocked in its positive
  // control (the normal leg is deliberately killed at its deadline), so even on
  // an idle machine it costs ~3.05 s — ~60% of bun's 5000 ms default per-test
  // timeout. Under a loaded lane the two cold child spawns can consume the
  // remaining ~2 s, and bun then fails the case at ~5002 ms with a bare
  // "timed out", discarding the child's stdout/stderr. The explicit budget sits
  // ABOVE the sum of this case's own child deadlines (15 s + 3 s = 18 s), so a
  // genuinely hung child is reported by spawnSync — naming the leg and showing
  // its output — before bun's timer can fire.
  const PROBE_DEADLINE_MS = 15_000;
  const NORMAL_DEADLINE_MS = 3_000;
  const CASE_BUDGET_MS = 20_000;

  // flair#1796 (follow-up F1): the sibling regression guard below spawns ONE
  // child with a 20 s deadline but carried no per-test budget, so it inherited
  // bun's 5000 ms default — a hung child there would surface as a bare
  // "timed out" instead of the named leg. Its budget sits ABOVE that child
  // deadline (20 s child + 2 s spawn/assert headroom, the same +2 s pattern as
  // CASE_BUDGET_MS above: 15 s + 3 s of deadlines + 2 s), and its overrun routes
  // through childOverranDeadline with its own leg name.
  const NOOP_DEADLINE_MS = 20_000;
  const NOOP_CASE_BUDGET_MS = 22_000;

  // flair#1796 (follow-up F2): probe mode exists to be FAST, but the 20 s case
  // budget above also silences a probe leg that is slow-but-not-hung — it would
  // pass anywhere under 20 s. Keep an alarm on the PROBE leg's measured wall
  // time alone. Bound from measured lane numbers on this 2-core host (60
  // samples each): idle min/median/max = 21/23/37 ms; under a 6x parallel
  // whole-suite load, 39/88/270 ms. 2000 ms is ~7x the loaded max and sits
  // below the positive control's fixed 3 s, so ordinary spawn variance is not an
  // alarm while a genuinely-slow probe leg is.
  const PROBE_LEG_BOUND_MS = 2_000;

  // If the entry point is not where this file thinks it is, FAIL loudly — an
  // unrun check must never look like a pass.
  test("the hook entry point exists to be probed", () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  test(
    "FLAIR_HOOK_PROBE with a real identity → inert output, exit 0, and the key file never opened",
    () => {
      // Asserted through a SIDE EFFECT rather than a timing margin, so this
      // detects the short-circuit being removed rather than merely being slow.
      //
      // FLAIR_KEY_PATH points at a FIFO. Anything that constructs the Flair
      // client and starts a signed request opens that path for reading, which
      // blocks forever because nothing will ever write to it. So:
      //   probe mode  → never opens it → prints {} and exits 0
      //   normal mode → opens it       → never exits
      // The second leg is the positive control: without it, the first would pass
      // just as happily if the hook had stopped doing anything at all.
      const dir = mkdtempSync(join(tmpdir(), "flair-hook-probe-"));
      const fifo = join(dir, "identity.key");
      try {
        const made = spawnSync("mkfifo", [fifo], { encoding: "utf-8" });
        // A missing mkfifo must FAIL, not silently skip the whole assertion.
        expect(made.status).toBe(0);

        const env = {
          ...process.env,
          FLAIR_AGENT_ID: "probe-test-agent",
          FLAIR_URL: "http://127.0.0.1:1",
          FLAIR_KEY_PATH: fifo,
        };

        const probeStart = performance.now();
        const probed = spawnSync(process.execPath, [ENTRY], {
          input: "{}",
          encoding: "utf-8",
          timeout: PROBE_DEADLINE_MS,
          env: { ...env, FLAIR_HOOK_PROBE: "1" },
        });
        const probeMs = performance.now() - probeStart;
        // flair#1796: name the leg and show what it produced, instead of letting
        // bun's per-test timer replace this with a bare "timed out".
        if (probed.signal !== null || probed.status !== 0) {
          throw new Error(childOverranDeadline("probe", PROBE_DEADLINE_MS, probed));
        }
        expect(probed.signal).toBeNull();
        expect(probed.status).toBe(0);
        expect(probed.stdout).toBe(NOOP);
        // flair#1796 (follow-up F2): the 20 s case budget absorbs load, so a
        // slow-but-not-hung probe leg would pass silently. Alarm on the PROBE
        // leg's own measured duration, named with the leg, the measured ms and
        // the bound (bound rationale: PROBE_LEG_BOUND_MS above).
        expect(
          probeMs,
          `hook entry point (probe leg) took ${Math.round(probeMs)} ms, above the ${PROBE_LEG_BOUND_MS} ms probe-leg bound — probe mode must stay fast`,
        ).toBeLessThanOrEqual(PROBE_LEG_BOUND_MS);

        const normal = spawnSync(process.execPath, [ENTRY], {
          input: "{}",
          encoding: "utf-8",
          timeout: NORMAL_DEADLINE_MS,
          env: { ...env, FLAIR_HOOK_PROBE: "" },
        });
        expect(normal.status).toBeNull(); // killed at the deadline — it did open the key
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CASE_BUDGET_MS,
  );

  test(
    "without FLAIR_HOOK_PROBE the binary still no-ops safely (regression guard)",
    () => {
      // The positive control for the two tests above: probe mode is an ADDITION,
      // it must not have become the only path.
      const res = spawnSync(process.execPath, [ENTRY], {
        input: "{}",
        encoding: "utf-8",
        timeout: NOOP_DEADLINE_MS,
        env: { ...process.env, FLAIR_HOOK_PROBE: "", FLAIR_AGENT_ID: "" },
      });
      // flair#1796 (follow-up F1): name THIS leg too, so a hung child is reported
      // by spawnSync with its output rather than as a bare bun "timed out".
      if (res.signal !== null || res.status !== 0) {
        throw new Error(childOverranDeadline("no-probe regression", NOOP_DEADLINE_MS, res));
      }
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
      expect(res.stdout).toBe(NOOP);
    },
    NOOP_CASE_BUDGET_MS,
  );
});
