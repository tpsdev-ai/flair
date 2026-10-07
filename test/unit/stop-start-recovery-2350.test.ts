/**
 * stop-start-recovery-2350.test.ts — the decision behind flair#2350, plus the
 * port probe it rides on (exercised through a REAL TCP listener).
 *
 *   `decideStartOnUnknown`: `flair start`'s resolution of the classifier's
 *   UNKNOWN "no pid + health silent" verdict — proceed on a provably free
 *   port, else refuse and name the remedy.
 *
 * The probe is checked against a real server and a real closed port, not a
 * stub: the whole point is what a live socket does.
 */
import { describe, test, expect } from "bun:test";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import {
  classifyPortProbe,
  decideStartOnUnknown,
  probePortListening,
} from "../../src/lib/stop-start-recovery.ts";

/** Ask the OS for a free port and release it, so a probe against it is "free". */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("classifyPortProbe", () => {
  test("an accepted connection is a listener", () => {
    expect(classifyPortProbe(undefined, true)).toBe("listening");
  });
  test("only the unreachable errnos are 'free'", () => {
    expect(classifyPortProbe("ECONNREFUSED", false)).toBe("free");
    expect(classifyPortProbe("EHOSTUNREACH", false)).toBe("free");
    expect(classifyPortProbe("ENETUNREACH", false)).toBe("free");
  });
  test("a timeout or any other error is 'unknown', never 'free'", () => {
    expect(classifyPortProbe(undefined, false)).toBe("unknown");
    expect(classifyPortProbe("EACCES", false)).toBe("unknown");
    expect(classifyPortProbe("ECONNRESET", false)).toBe("unknown");
  });
});

describe("probePortListening (real sockets)", () => {
  test("reports 'listening' for a real server", async () => {
    const srv = createHttpServer(() => {});
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await probePortListening(port)).toBe("listening");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  test("reports 'free' for a port nothing is bound to", async () => {
    const port = await freePort();
    expect(await probePortListening(port)).toBe("free");
  });
});

describe("decideStartOnUnknown", () => {
  test("a provably free port proceeds to start", () => {
    const d = decideStartOnUnknown({ detail: "no pid is recorded and the health check did not respond", port: 19995, probe: "free" });
    expect(d.proceed).toBe(true);
    expect(d.lines.join("\n")).toContain("Nothing is accepting connections on port 19995");
    expect(d.lines.join("\n")).not.toContain("Refusing");
  });

  test("a listener refuses and names the stop remedy", () => {
    const d = decideStartOnUnknown({ detail: "no pid is recorded and the health check did not respond", port: 19995, probe: "listening" });
    expect(d.proceed).toBe(false);
    const text = d.lines.join("\n");
    expect(text).toContain("Refusing to start");
    expect(text).toContain("flair stop --port 19995");
  });

  test("an undecidable probe refuses and names the inspect remedy", () => {
    const d = decideStartOnUnknown({ detail: "no pid is recorded and the health check did not respond", port: 19995, probe: "unknown" });
    expect(d.proceed).toBe(false);
    const text = d.lines.join("\n");
    expect(text).toContain("Refusing to start");
    expect(text).toContain("flair doctor");
  });
});
