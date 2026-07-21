/**
 * ops-socket-posture.test.ts — Unit tests for the ops-API domain-socket
 * permission posture added by flair#763 (split from #670; same local-admin
 * surface axis as #654's authorizeLocal-off and #762's loopback bind).
 *
 * The socket (dataDir/operations-server) is gated primarily by its immediate
 * parent directory — a race-free, umask-independent, cross-platform control —
 * with the socket file mode as defense-in-depth:
 *
 *   FLAIR_SOCKET_GROUP unset → parent dir 0700, socket 0600.
 *   FLAIR_SOCKET_GROUP set    → parent dir 0750, socket 0660 + chgrp to it.
 *
 * The two layers move in lockstep both directions (a later unset returns dir
 * → 0700, socket → 0600). Same house pattern as ops-api-bind.test.ts: the pure
 * decision + application logic is exported from cli.ts and exercised directly
 * with an in-memory fs and a mocked group resolver — no real socket, no chmod
 * of a real ~/.flair (the CLAUDE.md safety rail: tests touch temp/fake fs only).
 */

import { describe, test, expect } from "bun:test";
import { dirname } from "node:path";
import {
  SOCKET_GROUP_NAME_RE,
  isValidSocketGroupName,
  resolveSocketPosture,
  applyOpsSocketPosture,
  classifyOpsSocketPosture,
  type OpsSocketPostureFs,
} from "../../src/cli.ts";

// ─── In-memory fs double ────────────────────────────────────────────────────

class FakeFs implements OpsSocketPostureFs {
  chmods: Array<{ path: string; mode: number }> = [];
  chowns: Array<{ path: string; uid: number; gid: number }> = [];
  private modes = new Map<string, number>();
  private uids = new Map<string, number>();
  chownThrows?: Error;

  /** `existing` seeds paths that "exist" (dirs never need seeding — chmod on a
   *  dir is unconditional; only the socket's existence is gated on). */
  constructor(existing: Record<string, { mode?: number; uid?: number }> = {}) {
    for (const [p, v] of Object.entries(existing)) {
      this.modes.set(p, v.mode ?? 0o755);
      this.uids.set(p, v.uid ?? 501);
    }
  }
  chmodSync(path: string, mode: number) {
    this.chmods.push({ path, mode });
    this.modes.set(path, mode);
  }
  chownSync(path: string, uid: number, gid: number) {
    if (this.chownThrows) throw this.chownThrows;
    this.chowns.push({ path, uid, gid });
  }
  existsSync(path: string) {
    return this.modes.has(path);
  }
  statSync(path: string) {
    return { mode: this.modes.get(path) ?? 0, uid: this.uids.get(path) ?? 501, gid: 0 };
  }
  modeOf(path: string) {
    return this.modes.get(path);
  }
}

const SOCK = "/data/inst/operations-server";
const DIR = dirname(SOCK); // "/data/inst"

// ─── resolveSocketPosture (pure two-state source of truth) ───────────────────

describe("resolveSocketPosture", () => {
  test("unset → owner-only: dir 0700, socket 0600", () => {
    for (const g of [undefined, null, "", "   "]) {
      const p = resolveSocketPosture(g as any);
      expect(p.dirMode).toBe(0o700);
      expect(p.socketMode).toBe(0o600);
      expect(p.group).toBeNull();
    }
  });

  test("set → owner+group: dir 0750, socket 0660, trimmed group name", () => {
    const p = resolveSocketPosture("  flairadmin  ");
    expect(p.dirMode).toBe(0o750);
    expect(p.socketMode).toBe(0o660);
    expect(p.group).toBe("flairadmin");
  });
});

// ─── applyOpsSocketPosture — DEFAULT posture ─────────────────────────────────

describe("applyOpsSocketPosture — default (no group)", () => {
  test("socket present → dir 0700 + socket 0600, no chgrp", () => {
    const fs = new FakeFs({ [SOCK]: { mode: 0o755, uid: 501 } });
    const r = applyOpsSocketPosture({ socketPath: SOCK, group: undefined, fs });
    expect(fs.modeOf(DIR)).toBe(0o700);
    expect(fs.modeOf(SOCK)).toBe(0o600);
    expect(fs.chowns).toHaveLength(0);
    expect(r.socketApplied).toBe(true);
    expect(r.group).toBeNull();
    expect(r.gid).toBeNull();
  });

  test("socket absent (pre-boot) → dir gate only, socketApplied false", () => {
    const fs = new FakeFs(); // socket not seeded → does not exist
    const r = applyOpsSocketPosture({ socketPath: SOCK, group: undefined, fs });
    expect(fs.modeOf(DIR)).toBe(0o700);
    expect(fs.modeOf(SOCK)).toBeUndefined(); // never chmod'd
    expect(fs.chowns).toHaveLength(0);
    expect(r.socketApplied).toBe(false);
    expect(r.dirApplied).toBe(true);
  });
});

// ─── applyOpsSocketPosture — GROUP opt-in posture ────────────────────────────

describe("applyOpsSocketPosture — FLAIR_SOCKET_GROUP opt-in", () => {
  test("valid existing group → dir 0750 + socket 0660 + chgrp(uid unchanged, gid)", () => {
    const fs = new FakeFs({ [SOCK]: { mode: 0o755, uid: 501 } });
    const resolveGid = (name: string) => (name === "flairadmin" ? 2000 : null);
    const r = applyOpsSocketPosture({ socketPath: SOCK, group: "flairadmin", fs, resolveGid });
    expect(fs.modeOf(DIR)).toBe(0o750);
    expect(fs.modeOf(SOCK)).toBe(0o660);
    expect(fs.chowns).toEqual([{ path: SOCK, uid: 501, gid: 2000 }]);
    expect(r.group).toBe("flairadmin");
    expect(r.gid).toBe(2000);
    expect(r.socketApplied).toBe(true);
    expect(r.broadGroup).toBe(false);
  });

  test("group set but socket absent → dir 0750, group validated, no chgrp yet", () => {
    const fs = new FakeFs();
    const resolveGid = (name: string) => 2000;
    const r = applyOpsSocketPosture({ socketPath: SOCK, group: "flairadmin", fs, resolveGid });
    expect(fs.modeOf(DIR)).toBe(0o750);
    expect(fs.chowns).toHaveLength(0);
    expect(r.gid).toBe(2000);
    expect(r.socketApplied).toBe(false);
  });

  test("broad system group (staff) → still applied, but flagged broadGroup", () => {
    const fs = new FakeFs({ [SOCK]: { mode: 0o755, uid: 501 } });
    const r = applyOpsSocketPosture({ socketPath: SOCK, group: "staff", fs, resolveGid: () => 20 });
    expect(r.broadGroup).toBe(true);
    expect(fs.modeOf(SOCK)).toBe(0o660);
  });
});

// ─── Group-name validation (regex BEFORE existence resolution) ────────────────

describe("applyOpsSocketPosture — group-name validation (fail-closed)", () => {
  test("invalid group name → hard error, resolveGid NEVER called (regex first)", () => {
    const fs = new FakeFs({ [SOCK]: { mode: 0o755, uid: 501 } });
    let resolveCalls = 0;
    const resolveGid = () => {
      resolveCalls++;
      return 2000;
    };
    for (const bad of ["../../etc/shadow", "bad group", "-leading", "5starts", "with/slash", "semi;colon"]) {
      expect(() => applyOpsSocketPosture({ socketPath: SOCK, group: bad, fs, resolveGid })).toThrow(/Invalid FLAIR_SOCKET_GROUP/);
    }
    expect(resolveCalls).toBe(0); // regex rejected every one before existence resolution
    // Fail-closed: validation throws BEFORE any chmod — no silent fallback, and
    // not even the dir gate is touched (the socket keeps its original mode).
    expect(fs.chmods).toHaveLength(0);
    expect(fs.modeOf(SOCK)).toBe(0o755); // untouched
    expect(fs.modeOf(DIR)).toBeUndefined();
  });

  test("valid-but-missing group → hard error (no silent 0600 fallback)", () => {
    const fs = new FakeFs({ [SOCK]: { mode: 0o755, uid: 501 } });
    const resolveGid = () => null; // getgrnam miss
    expect(() => applyOpsSocketPosture({ socketPath: SOCK, group: "ghostgroup", fs, resolveGid })).toThrow(/does not exist/);
    expect(fs.chmods).toHaveLength(0); // threw before any chmod — no fallback to 0600
    expect(fs.modeOf(SOCK)).toBe(0o755); // untouched
    expect(fs.chowns).toHaveLength(0);
  });

  test("chgrp failure (exists but not a member) → clear membership error", () => {
    const fs = new FakeFs({ [SOCK]: { mode: 0o755, uid: 501 } });
    fs.chownThrows = Object.assign(new Error("EPERM"), { code: "EPERM" });
    expect(() => applyOpsSocketPosture({ socketPath: SOCK, group: "othergrp", fs, resolveGid: () => 3000 })).toThrow(/requires membership/);
  });

  test("SOCKET_GROUP_NAME_RE / isValidSocketGroupName accept & reject the right shapes", () => {
    for (const ok of ["flair", "_flair", "flair-admin", "flair.grp", "a1_2.3-4", "staff"]) {
      expect(isValidSocketGroupName(ok)).toBe(true);
      expect(SOCKET_GROUP_NAME_RE.test(ok)).toBe(true);
    }
    for (const bad of ["1abc", "-abc", ".abc", "a b", "a/b", "a$b", "", "a;b"]) {
      expect(isValidSocketGroupName(bad)).toBe(false);
    }
  });
});

// ─── Lockstep BOTH directions ────────────────────────────────────────────────

describe("applyOpsSocketPosture — lockstep both directions", () => {
  test("set-then-unset: 0700/0600 → 0750/0660 → back to 0700/0600", () => {
    const fs = new FakeFs({ [SOCK]: { mode: 0o755, uid: 501 } });

    // 1. Default posture.
    applyOpsSocketPosture({ socketPath: SOCK, group: undefined, fs });
    expect(fs.modeOf(DIR)).toBe(0o700);
    expect(fs.modeOf(SOCK)).toBe(0o600);

    // 2. Opt in → dir + socket widen together.
    applyOpsSocketPosture({ socketPath: SOCK, group: "flairadmin", fs, resolveGid: () => 2000 });
    expect(fs.modeOf(DIR)).toBe(0o750);
    expect(fs.modeOf(SOCK)).toBe(0o660);
    expect(fs.chowns).toHaveLength(1);

    // 3. Unset → dir + socket tighten back together (lockstep the other way).
    applyOpsSocketPosture({ socketPath: SOCK, group: undefined, fs });
    expect(fs.modeOf(DIR)).toBe(0o700);
    expect(fs.modeOf(SOCK)).toBe(0o600);
    // No new chgrp on the way back — 0600 removes group access outright.
    expect(fs.chowns).toHaveLength(1);
  });
});

// ─── Doctor detection matrix — Sherlock's exact SIX rows ─────────────────────

describe("classifyOpsSocketPosture — the six-row doctor matrix", () => {
  test("row 1 — dir 0700 + socket 0600 (no opt-in) → CLEAN (default-clean)", () => {
    const v = classifyOpsSocketPosture(0o700, 0o600, false);
    expect(v.flagged).toBe(false);
    expect(v.row).toBe("default-clean");
  });

  test("row 2 — dir 0755 + socket 0600 (no opt-in) → FLAG (root-open)", () => {
    const v = classifyOpsSocketPosture(0o755, 0o600, false);
    expect(v.flagged).toBe(true);
    expect(v.row).toBe("root-open");
  });

  test("row 3 — dir 0700 + socket 0755 (no opt-in) → FLAG (socket-open)", () => {
    const v = classifyOpsSocketPosture(0o700, 0o755, false);
    expect(v.flagged).toBe(true);
    expect(v.row).toBe("socket-open");
  });

  test("row 4 — dir 0755 + socket 0755 (no opt-in) → FLAG (both-open)", () => {
    const v = classifyOpsSocketPosture(0o755, 0o755, false);
    expect(v.flagged).toBe(true);
    expect(v.row).toBe("both-open");
  });

  test("row 5 — dir 0750 + socket 0660 + FLAIR_SOCKET_GROUP set → CLEAN (deliberate-group-clean)", () => {
    const v = classifyOpsSocketPosture(0o750, 0o660, true);
    expect(v.flagged).toBe(false);
    expect(v.row).toBe("deliberate-group-clean");
  });

  test("row 6 — dir 0750 + socket 0660 + NO FLAIR_SOCKET_GROUP → FLAG (group-mode-without-opt-in)", () => {
    const v = classifyOpsSocketPosture(0o750, 0o660, false);
    expect(v.flagged).toBe(true);
    expect(v.row).toBe("group-mode-without-opt-in");
  });

  test("robustness — a world-open regression while opted-in is still flagged", () => {
    const v = classifyOpsSocketPosture(0o750, 0o755, true);
    expect(v.flagged).toBe(true);
    expect(v.row).toBe("group-opt-in-world-open");
  });

  test("high mode bits (setuid/sticky) are ignored — only rwx bits classify", () => {
    // 0o41700-style st.mode carries file-type bits; classifier masks to 0o777.
    const v = classifyOpsSocketPosture(0o40700, 0o140600, false);
    expect(v.flagged).toBe(false);
    expect(v.row).toBe("default-clean");
  });
});
