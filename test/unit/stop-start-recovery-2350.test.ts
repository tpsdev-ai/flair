import { describe, test, expect } from "bun:test";
import type { DaemonEvidence } from "../../src/lib/daemon-liveness.ts";
import {
  classifyPortProbe,
  decideStartOnUnknown,
} from "../../src/lib/stop-start-recovery.ts";

describe("classifyPortProbe", () => {
  test("an accepted connection is a listener", () => {
    expect(classifyPortProbe(undefined, true)).toBe("listening");
  });
  test("only ECONNREFUSED returns free", () => {
    expect(classifyPortProbe("ECONNREFUSED", false)).toBe("free");
    expect(classifyPortProbe("EHOSTUNREACH", false)).toBe("unknown");
    expect(classifyPortProbe("ENETUNREACH", false)).toBe("unknown");
  });
  test("a timeout or any other error is 'unknown', never 'free'", () => {
    expect(classifyPortProbe(undefined, false)).toBe("unknown");
    expect(classifyPortProbe("EACCES", false)).toBe("unknown");
    expect(classifyPortProbe("ECONNRESET", false)).toBe("unknown");
  });
});

function exitedOwner(): DaemonEvidence {
  return { dataDirUnsafe: null, pidfile: { kind: "absent" }, lastKnownPid: 12345,
    pidLiveness: { kind: "gone" }, identity: { kind: "none" }, health: { kind: "unreachable" } };
}

describe("decideStartOnUnknown", () => {
  test.each([
    ["unsafe data directory", { dataDirUnsafe: "unsafe directory" }],
    ["unreadable pid file", { pidfile: { kind: "unreadable", reason: "unreadable pid" } }],
    ["indeterminate PID liveness", { pidLiveness: { kind: "unknown", reason: "EACCES" } }],
    ["unreadable sidecar", { sidecar: { kind: "unreadable", reason: "unreadable sidecar" } }],
    ["different live sidecar owner", { sidecar: { kind: "present", pid: 54321, port: 19995, startTimeMs: 1, flairVersion: "test" }, sidecarLiveness: { kind: "alive" } }],
    ["no recorded owner", { lastKnownPid: undefined, pidLiveness: null }],
    ["live owner without a listener", { pidLiveness: { kind: "alive" } }],
    ["owner belonging to another user", { pidLiveness: { kind: "eperm" } }],
  ] as const)("refuses %s despite a refused connection", (_name, patch) => {
    const evidence = { ...exitedOwner(), ...patch } as DaemonEvidence;
    expect(decideStartOnUnknown({ evidence, detail: "unknown", port: 19995, probe: "free" }).proceed).toBe(false);
  });
  test("an exited recorded owner and a refused connection permit recovery", () => {
    const d = decideStartOnUnknown({ evidence: exitedOwner(), detail: "no pid is recorded and the health check did not respond", port: 19995, probe: "free" });
    expect(d.proceed).toBe(true);
    expect(d.lines.join("\n")).toContain("Recorded owner has exited");
    expect(d.lines.join("\n")).not.toContain("Refusing");
  });

  test("a listener refuses and names the diagnostic action", () => {
    const d = decideStartOnUnknown({ evidence: exitedOwner(), detail: "no pid is recorded and the health check did not respond", port: 19995, probe: "listening" });
    expect(d.proceed).toBe(false);
    const text = d.lines.join("\n");
    expect(text).toContain("Refusing to start");
    expect(text).toContain("flair doctor");
  });

  test("an undecidable probe refuses and names the diagnostic action", () => {
    const d = decideStartOnUnknown({ evidence: exitedOwner(), detail: "no pid is recorded and the health check did not respond", port: 19995, probe: "unknown" });
    expect(d.proceed).toBe(false);
    const text = d.lines.join("\n");
    expect(text).toContain("Refusing to start");
    expect(text).toContain("flair doctor");
  });
});
