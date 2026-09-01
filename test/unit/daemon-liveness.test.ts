// daemon-liveness.test.ts — flair#1454.
//
// The defect: `flair stop` decided "not running" from a single
// `lsof -ti :<port>` whose `catch` converted "lsof unavailable" into "nothing
// is listening" — absence rendered as a definite negative. `flair start` then
// "succeeded" over the live daemon it had just failed to see, and a
// `stop; start` wrapper produced a second daemon while the first kept running.
//
// The fix is a FIVE-state classifier (RUNNING | NOT_RUNNING | WEDGED |
// DISAGREEMENT | UNKNOWN) with one load-bearing invariant:
//
//   WEDGED is reachable ONLY when the pidfile identity has been VERIFIED.
//   The same physical evidence with an unverified identity is DISAGREEMENT.
//
// This file pins that invariant structurally — the classifier takes the
// identity-check RESULT as an input, and there is no code path to WEDGED that
// bypasses it. The mutation-check (acceptance f) is the test that forges a
// stale sidecar (correct pid, wrong startTimeMs) against a live process and
// asserts the outcome is DISAGREEMENT, not WEDGED: if that ever flips, the
// invariant is decorative and the build must fail.
//
// Everything here is PURE — no filesystem, no network, no process. The
// adapters that touch those (O_NOFOLLOW reads, kill(pid,0), the health probe,
// the start-time readers) live in src/cli.ts and are exercised end-to-end by
// the hostile-lane check (acceptance a) and the integration suite.
import { describe, test, expect } from "bun:test";
import {
  classifyDaemonState,
  verifyIdentity,
  isStartTimeMatch,
  parseProcStatStartTime,
  procStartTimeToEpochMs,
  parsePsLstart,
  parseSidecarJson,
  type DaemonEvidence,
  type DaemonContext,
  type SidecarRead,
} from "../../src/lib/daemon-liveness.ts";

const ctx: DaemonContext = { port: 19926, dataDir: "/home/u/.flair/data" };

/** A verified identity for `pid`. */
function verified(pid: number) {
  return { kind: "verified" as const, pid };
}
function unverified(reason: string) {
  return { kind: "unverified" as const, reason };
}
const none = { kind: "none" as const };

function sidecar(pid: number, startTimeMs: number): SidecarRead {
  return { kind: "present", pid, startTimeMs, port: 19926, flairVersion: "0.50.0" };
}

/** Build evidence with sensible defaults, overridden per test. */
function ev(overrides: Partial<DaemonEvidence>): DaemonEvidence {
  return {
    dataDirUnsafe: null,
    pidfile: { kind: "absent" },
    pidLiveness: null,
    identity: none,
    health: { kind: "refused" },
    ...overrides,
  };
}

// ─── the five states ────────────────────────────────────────────────────────

describe("flair#1454 — classifyDaemonState", () => {
  test("RUNNING: verified identity, alive pid, health ok", () => {
    const s = classifyDaemonState(ev({
      pidfile: { kind: "present", pid: 4242 },
      pidLiveness: { kind: "alive" },
      identity: verified(4242),
      health: { kind: "ok" },
    }), ctx);
    expect(s).toEqual({ state: "RUNNING", pid: 4242 });
  });

  test("WEDGED: verified identity, alive pid, health refused", () => {
    const s = classifyDaemonState(ev({
      pidfile: { kind: "present", pid: 4242 },
      pidLiveness: { kind: "alive" },
      identity: verified(4242),
      health: { kind: "refused" },
    }), ctx);
    expect(s).toEqual({ state: "WEDGED", pid: 4242 });
  });

  test("WEDGED: verified identity, alive pid, health unreachable (SIGSTOP'd)", () => {
    const s = classifyDaemonState(ev({
      pidfile: { kind: "present", pid: 4242 },
      pidLiveness: { kind: "alive" },
      identity: verified(4242),
      health: { kind: "unreachable" },
    }), ctx);
    expect(s).toEqual({ state: "WEDGED", pid: 4242 });
  });

  test("NOT_RUNNING: no pidfile, health refused", () => {
    const s = classifyDaemonState(ev({ health: { kind: "refused" } }), ctx);
    expect(s).toEqual({ state: "NOT_RUNNING" });
  });

  test("NOT_RUNNING: recorded pid is gone, health refused", () => {
    const s = classifyDaemonState(ev({
      pidfile: { kind: "present", pid: 4242 },
      pidLiveness: { kind: "gone" },
      health: { kind: "refused" },
    }), ctx);
    expect(s).toEqual({ state: "NOT_RUNNING" });
  });

  test("DISAGREEMENT: no pidfile but something is serving the port", () => {
    const s = classifyDaemonState(ev({ health: { kind: "ok" } }), ctx);
    expect(s.state).toBe("DISAGREEMENT");
    expect((s as any).detail).toContain("19926");
  });

  test("DISAGREEMENT: recorded pid is gone but something is serving the port", () => {
    const s = classifyDaemonState(ev({
      pidfile: { kind: "present", pid: 4242 },
      pidLiveness: { kind: "gone" },
      health: { kind: "ok" },
    }), ctx);
    expect(s.state).toBe("DISAGREEMENT");
  });

  test("DISAGREEMENT: EPERM — the recorded pid exists but belongs to another user", () => {
    const s = classifyDaemonState(ev({
      pidfile: { kind: "present", pid: 4242 },
      pidLiveness: { kind: "eperm" },
      health: { kind: "ok" },
    }), ctx);
    expect(s.state).toBe("DISAGREEMENT");
    expect((s as any).detail).toContain("another user");
  });

  test("UNKNOWN: no pidfile, health unreachable", () => {
    const s = classifyDaemonState(ev({ health: { kind: "unreachable" } }), ctx);
    expect(s.state).toBe("UNKNOWN");
    expect((s as any).detail).not.toContain("not running");
  });

  test("UNKNOWN: data dir is a symlink or world-writable", () => {
    const s = classifyDaemonState(ev({ dataDirUnsafe: "data directory is a symbolic link" }), ctx);
    expect(s.state).toBe("UNKNOWN");
    expect((s as any).detail).toContain("symbolic link");
  });

  test("UNKNOWN: pidfile is unreadable", () => {
    const s = classifyDaemonState(ev({ pidfile: { kind: "unreadable", reason: "hdb.pid is a symbolic link" } }), ctx);
    expect(s.state).toBe("UNKNOWN");
    expect((s as any).detail).toContain("symbolic link");
  });
});

// ─── THE INVARIANT (acceptance f) ───────────────────────────────────────────

describe("flair#1454 — the WEDGED/DISAGREEMENT invariant", () => {
  test("THE GATE: a stale sidecar (correct pid, wrong startTimeMs) against a live process is DISAGREEMENT, never WEDGED", () => {
    // The exact scenario acceptance (f) describes: a live process, a pidfile
    // naming it, and a sidecar whose pid matches but whose startTimeMs does
    // not. If this ever reaches WEDGED, the invariant is decorative and the
    // build must fail.
    const s = classifyDaemonState(ev({
      pidfile: { kind: "present", pid: 4242 },
      pidLiveness: { kind: "alive" },
      identity: unverified("pid 4242 started at 1000ms but the sidecar records 999999ms"),
      health: { kind: "refused" },
    }), ctx);
    expect(s.state).toBe("DISAGREEMENT");
  });

  test("POSITIVE CONTROL: the SAME evidence with a verified identity IS WEDGED", () => {
    const s = classifyDaemonState(ev({
      pidfile: { kind: "present", pid: 4242 },
      pidLiveness: { kind: "alive" },
      identity: verified(4242),
      health: { kind: "refused" },
    }), ctx);
    expect(s.state).toBe("WEDGED");
  });

  test("every unverified-identity shape lands in DISAGREEMENT, never WEDGED", () => {
    // Structural: for a live pid that is not serving, the ONLY thing that
    // separates WEDGED from DISAGREEMENT is the identity result. Walk every
    // unverified shape and assert none of them reaches WEDGED.
    const unverifiedShapes = [
      none,
      unverified("no identity sidecar"),
      unverified("hdb.pid names pid 4242 but the sidecar records pid 9999"),
      unverified("could not read the start time of pid 4242"),
      unverified("pid 4242 started at 1000ms but the sidecar records 999999ms"),
    ];
    for (const identity of unverifiedShapes) {
      const s = classifyDaemonState(ev({
        pidfile: { kind: "present", pid: 4242 },
        pidLiveness: { kind: "alive" },
        identity,
        health: { kind: "refused" },
      }), ctx);
      expect(s.state).toBe("DISAGREEMENT");
    }
  });

  test("a live pid with an unverified identity is DISAGREEMENT even when health is ok", () => {
    // The "already running but I can't prove it's mine" shape — start must
    // refuse, not report RUNNING.
    const s = classifyDaemonState(ev({
      pidfile: { kind: "present", pid: 4242 },
      pidLiveness: { kind: "alive" },
      identity: unverified("no identity sidecar"),
      health: { kind: "ok" },
    }), ctx);
    expect(s.state).toBe("DISAGREEMENT");
  });
});

// ─── verifyIdentity ─────────────────────────────────────────────────────────

describe("flair#1454 — verifyIdentity", () => {
  const readStartTime = (pid: number) => (pid === 4242 ? 1_000_000 : null);

  test("verified: pid matches and start time is within tolerance", () => {
    expect(verifyIdentity({
      pidfilePid: 4242,
      sidecar: sidecar(4242, 1_000_000),
      readStartTime,
    })).toEqual({ kind: "verified", pid: 4242 });
  });

  test("verified: start time within the ±2s tolerance is accepted", () => {
    expect(verifyIdentity({
      pidfilePid: 4242,
      sidecar: sidecar(4242, 1_001_999),
      readStartTime,
    })).toEqual({ kind: "verified", pid: 4242 });
  });

  test("unverified: start time outside the ±2s tolerance is rejected", () => {
    const r = verifyIdentity({
      pidfilePid: 4242,
      sidecar: sidecar(4242, 1_002_001),
      readStartTime,
    });
    expect(r.kind).toBe("unverified");
  });

  test("unverified: pidfile pid does not match the sidecar pid", () => {
    const r = verifyIdentity({
      pidfilePid: 4242,
      sidecar: sidecar(9999, 1_000_000),
      readStartTime,
    });
    expect(r.kind).toBe("unverified");
    expect((r as any).reason).toContain("4242");
    expect((r as any).reason).toContain("9999");
  });

  test("unverified: the live start time cannot be read", () => {
    const r = verifyIdentity({
      pidfilePid: 4242,
      sidecar: sidecar(4242, 1_000_000),
      readStartTime: () => null,
    });
    expect(r.kind).toBe("unverified");
  });

  test("none: no pidfile pid", () => {
    expect(verifyIdentity({ pidfilePid: null, sidecar: sidecar(4242, 1), readStartTime }))
      .toEqual({ kind: "none" });
  });

  test("none: no sidecar", () => {
    expect(verifyIdentity({ pidfilePid: 4242, sidecar: { kind: "absent" }, readStartTime }))
      .toEqual({ kind: "none" });
  });

  test("unverified: an unreadable sidecar carries its reason", () => {
    const r = verifyIdentity({
      pidfilePid: 4242,
      sidecar: { kind: "unreadable", reason: "flair-daemon.json is a symbolic link" },
      readStartTime,
    });
    expect(r.kind).toBe("unverified");
    expect((r as any).reason).toContain("symbolic link");
  });
});

// ─── start-time parsing ─────────────────────────────────────────────────────

describe("flair#1454 — parseProcStatStartTime", () => {
  // A realistic /proc/<pid>/stat line. Field 22 (starttime) is 123456.
  const stat = "4242 (harper) S 1 4242 4242 0 -1 4194560 100 0 0 0 10 5 0 0 20 0 1 0 123456 100000 2000";

  test("reads field 22 (starttime) out of a normal stat line", () => {
    expect(parseProcStatStartTime(stat)).toBe(123456);
  });

  test("a comm containing spaces does not shift the field", () => {
    const withSpaces = stat.replace("(harper)", "(harper db worker)");
    expect(parseProcStatStartTime(withSpaces)).toBe(123456);
  });

  test("a comm containing a ')' does not shift the field (split on the LAST ')')", () => {
    const withParen = stat.replace("(harper)", "(harper (db))");
    expect(parseProcStatStartTime(withParen)).toBe(123456);
  });

  test("a malformed line (no closing paren) is null, not a wrong number", () => {
    expect(parseProcStatStartTime("4242 harper S 1 2 3")).toBeNull();
  });
});

describe("flair#1454 — procStartTimeToEpochMs", () => {
  test("converts ticks-since-boot to epoch ms", () => {
    // boot at epoch 0, uptime 100s, starttime 50 ticks @ 100Hz = 500ms after boot.
    expect(procStartTimeToEpochMs(50, 100, 100_000)).toBe(500);
  });

  test("accounts for a nonzero boot time", () => {
    // now = 1_000_000ms, uptime 100s -> boot at 900_000ms; starttime 50 ticks -> +500ms.
    expect(procStartTimeToEpochMs(50, 100, 1_000_000)).toBe(900_500);
  });
});

describe("flair#1454 — parsePsLstart", () => {
  test("parses `ps -o lstart=` output to epoch ms", () => {
    const ms = parsePsLstart("Sat Aug 29 15:03:22 2026");
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBe(Date.parse("Sat Aug 29 15:03:22 2026"));
  });

  test("empty output is null, not NaN", () => {
    expect(parsePsLstart("   ")).toBeNull();
  });

  test("unparseable output is null", () => {
    expect(parsePsLstart("not a date")).toBeNull();
  });

  // flair#1454 darwin-gated: ps -o lstart= has 1s granularity — the worst-case
  // rounding is <1000ms. The ±2000ms tolerance in verifyIdentity must absorb it
  // even when the sidecar was written up to ~1s after spawn.
  //
  // What this tests: on a real darwin ps call, parsePsLstart produces a
  // non-null, plausible epoch for the current process; AND calling it twice in
  // quick succession (< 1100ms apart) gives values within ±2s of each other —
  // the same tolerance window verifyIdentity uses. The two-call delta is the
  // right comparison: it mirrors “sidecar written at t, ps read at t+skew”,
  // and it does NOT depend on Date.now() vs process.start (which grows without
  // bound for long-lived test processes).
  test.skipIf(process.platform !== "darwin")(
    "(darwin) ps -o lstart= 1s-granularity round-trip is within the ±2s tolerance used by verifyIdentity",
    () => {
      const { execFileSync } = require("node:child_process");
      const psArgs = ["-o", "lstart=", "-p", String(process.pid)];
      const psEnv = { ...process.env, LC_ALL: "C" };

      const raw1 = execFileSync("ps", psArgs, { encoding: "utf-8", env: psEnv, timeout: 2000 }) as string;
      const ms1 = parsePsLstart(raw1);
      expect(ms1).not.toBeNull();

      // A non-null result must be a plausible past epoch: after 2020 and not
      // in the future. This catches NaN / epoch-0 / Date.parse misparses.
      const EPOCH_2020 = Date.parse("2020-01-01T00:00:00Z");
      expect(ms1 as number).toBeGreaterThan(EPOCH_2020);
      expect(ms1 as number).toBeLessThanOrEqual(Date.now());

      // Two reads of the same (still-running) process must agree within ±2s.
      // This is the same window verifyIdentity uses for sidecar vs live start:
      // if two ps calls within a test agree, a sidecar written at spawn-time
      // and a ps read at stop-time will too (the 1s floor rounding is stable).
      const raw2 = execFileSync("ps", psArgs, { encoding: "utf-8", env: psEnv, timeout: 2000 }) as string;
      const ms2 = parsePsLstart(raw2);
      expect(ms2).not.toBeNull();
      expect(Math.abs((ms1 as number) - (ms2 as number))).toBeLessThan(2000);
    },
  );
});

// ─── sidecar parsing ────────────────────────────────────────────────────────

describe("flair#1454 — parseSidecarJson", () => {
  test("parses a well-formed sidecar", () => {
    expect(parseSidecarJson('{"pid":4242,"startTimeMs":1000000,"port":19926,"flairVersion":"0.50.0"}'))
      .toEqual({ pid: 4242, startTimeMs: 1_000_000, port: 19926, flairVersion: "0.50.0" });
  });

  test("malformed JSON is null", () => {
    expect(parseSidecarJson("{not json")).toBeNull();
  });

  test("a non-object is null", () => {
    expect(parseSidecarJson("[1,2,3]")).toBeNull();
  });

  test("a missing or non-positive pid is null", () => {
    expect(parseSidecarJson('{"startTimeMs":1,"port":19926}')).toBeNull();
    expect(parseSidecarJson('{"pid":0,"startTimeMs":1,"port":19926}')).toBeNull();
  });

  test("a missing startTimeMs is null", () => {
    expect(parseSidecarJson('{"pid":4242,"port":19926}')).toBeNull();
  });
});

describe("flair#1454 — isStartTimeMatch", () => {
  test("within tolerance", () => {
    expect(isStartTimeMatch(1_000_000, 1_001_999, 2000)).toBe(true);
    expect(isStartTimeMatch(1_000_000, 998_001, 2000)).toBe(true);
  });
  test("outside tolerance", () => {
    expect(isStartTimeMatch(1_000_000, 1_002_001, 2000)).toBe(false);
  });
});
