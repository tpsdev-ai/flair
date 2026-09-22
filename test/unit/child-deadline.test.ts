// child-deadline.test.ts — flair#1807 (carry-over from the #1813 review).
//
// `childOverranDeadline` used to call ANY death-by-signal "did not exit within
// <deadline> ms". That is a claim about the CHILD, and only one death supports
// it: the one the spawn's own `timeout` causes (SIGTERM by default) at or past
// the deadline. A SIGKILL from the OOM killer, or a SIGTERM from anywhere else,
// arrives on a different schedule and must be reported as what it was.
//
// Four cases, one per branch of the message, all through the helper.

import { describe, it, expect } from "bun:test";
import { childOverranDeadline } from "../helpers/child-deadline.js";

const DEADLINE_MS = 20_000;

describe("childOverranDeadline reports what actually killed the child (flair#1807)", () => {
  it("a SIGTERM at/past the deadline is an OVERRUN — the one death the deadline explains", () => {
    const msg = childOverranDeadline("flair CLI", "overrun leg", DEADLINE_MS, {
      status: null,
      signal: "SIGTERM",
      elapsedMs: DEADLINE_MS + 41,
      stdout: "partial output",
      stderr: "",
    });
    expect(msg).toContain("overran its 20000 ms deadline");
    expect(msg).toContain("killed by SIGTERM after 20041 ms");
    // The child's own output rides along — the whole point of not letting bun's
    // bare "timed out" replace this message.
    expect(msg).toContain("partial output");
  });

  it("an early SIGKILL is NOT an overrun — no deadline elapsed", () => {
    const msg = childOverranDeadline("flair CLI", "killed leg", DEADLINE_MS, {
      status: null,
      signal: "SIGKILL",
      elapsedMs: 5,
      stdout: "",
      stderr: "killed by the OOM killer",
    });
    expect(msg).toContain("killed by SIGKILL after 5 ms");
    expect(msg).not.toContain("overran");
    expect(msg).toContain("killed by the OOM killer");
  });

  it("the deadline signal BEFORE the deadline is still not an overrun", () => {
    const msg = childOverranDeadline("flair CLI", "early-term leg", DEADLINE_MS, {
      status: null,
      signal: "SIGTERM",
      elapsedMs: 12,
    });
    expect(msg).toContain("killed by SIGTERM after 12 ms");
    expect(msg).toContain("before the 20000 ms deadline was reached");
    expect(msg).not.toContain("overran");
  });

  it("with no measured elapsed it names the signal and claims no overrun", () => {
    const msg = childOverranDeadline("flair CLI", "unmeasured leg", DEADLINE_MS, {
      status: null,
      signal: "SIGSEGV",
    });
    expect(msg).toContain("killed by SIGSEGV");
    expect(msg).not.toContain("overran");
  });

  it("a normal exit is not reported as a deadline event at all", () => {
    const msg = childOverranDeadline("flair CLI", "exited leg", DEADLINE_MS, {
      status: 3,
      signal: null,
    });
    expect(msg).toContain("exited with status 3 and no signal");
    expect(msg).not.toContain("overran");
  });
});
