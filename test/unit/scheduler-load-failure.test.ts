/**
 * scheduler-load-failure.test.ts — flair#1107.
 *
 * `describeLoadFailure` used to print `loginctl enable-linger` for every
 * "Failed to connect to bus" on linux, even after the operator had already
 * enabled lingering. The remaining gap is this session's user-bus env.
 *
 * SAFETY: every case injects linger/env facts. No test spawns loginctl.
 */

import { describe, it, expect } from "bun:test";
import {
  describeLoadFailure,
  probeUserLingerEnabled,
  sessionHasUserBusEnv,
  type SpawnReport,
} from "../../src/lib/scheduler-platform.ts";

const NO_BUS = { code: 1, stderr: "Failed to connect to bus: No medium found\n" };
const ENABLE = "flair federation sync enable";

describe("describeLoadFailure (flair#1107 — do not repeat an applied linger remedy)", () => {
  it("still names loginctl enable-linger when lingering is off", () => {
    const remedy = describeLoadFailure("linux", NO_BUS, ENABLE, { lingerEnabled: false });
    expect(remedy).toContain("loginctl enable-linger");
    expect(remedy).toContain(ENABLE);
    expect(remedy).not.toContain("XDG_RUNTIME_DIR");
  });

  it("does not repeat the linger remedy after lingering is already on", () => {
    const remedy = describeLoadFailure("linux", NO_BUS, ENABLE, { lingerEnabled: true, env: {} });
    expect(remedy).not.toBeNull();
    expect(remedy).not.toContain("loginctl enable-linger <user>");
    expect(remedy).not.toMatch(/Fix: enable lingering/);
    expect(remedy).toContain("XDG_RUNTIME_DIR=/run/user/$(id -u)");
    expect(remedy).toContain("DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus");
    expect(remedy).toContain(ENABLE);
  });

  it("does not repeat linger or the export lines once both remedies have been applied", () => {
    const remedy = describeLoadFailure("linux", NO_BUS, ENABLE, {
      lingerEnabled: true,
      env: {
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
    });
    expect(remedy).not.toBeNull();
    expect(remedy).not.toContain("loginctl enable-linger <user>");
    expect(remedy).not.toMatch(/Fix: enable lingering/);
    expect(remedy).not.toContain("export XDG_RUNTIME_DIR");
    expect(remedy).not.toContain("export DBUS_SESSION_BUS_ADDRESS");
    expect(remedy).toContain(ENABLE);
  });

  it("keeps the linger remedy when linger state is unknown", () => {
    const remedy = describeLoadFailure("linux", NO_BUS, ENABLE);
    expect(remedy).toContain("loginctl enable-linger");
  });

  it("returns null for an unrecognized linux failure", () => {
    expect(describeLoadFailure("linux", { code: 1, stderr: "some other systemd error\n" }, ENABLE)).toBeNull();
  });
});

describe("sessionHasUserBusEnv", () => {
  it("is false when either variable is missing", () => {
    expect(sessionHasUserBusEnv({})).toBe(false);
    expect(sessionHasUserBusEnv({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(false);
    expect(sessionHasUserBusEnv({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" })).toBe(false);
  });

  it("is true only when both are set", () => {
    expect(sessionHasUserBusEnv({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    })).toBe(true);
  });
});

describe("probeUserLingerEnabled", () => {
  function reply(stdout: string, code = 0): SpawnReport {
    return { code, stdout, stderr: "" };
  }

  it("reads Linger=yes as already applied", () => {
    expect(probeUserLingerEnabled({ run: () => reply("Linger=yes\n") })).toBe(true);
  });

  it("reads Linger=no as not yet applied", () => {
    expect(probeUserLingerEnabled({ run: () => reply("Linger=no\n") })).toBe(false);
  });

  it("does not invent linger-off from a failed probe", () => {
    expect(probeUserLingerEnabled({
      run: () => reply("", 1),
      lingerStampExists: () => false,
    })).toBeNull();
  });

  it("believes the linger stamp when loginctl is inconclusive", () => {
    expect(probeUserLingerEnabled({
      run: () => reply("", 1),
      lingerStampExists: () => true,
    })).toBe(true);
  });
});
