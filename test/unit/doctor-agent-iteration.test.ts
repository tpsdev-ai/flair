/**
 * doctor-agent-iteration.test.ts — Unit tests for the pure decision logic
 * behind `flair doctor`'s per-agent iteration of the verified-read sections
 * (Fleet presence, Migrations) — flair#722.
 *
 * `doctor` previously ran those sections only when --agent was passed, even
 * though it already enumerates every key in ~/.flair/keys (the "Keys found:
 * N agent(s)" line). planAgentIterations() decides WHICH agent ids to
 * iterate (every key, or the --agent filter); describeAgentGateFinding()
 * decides how one agent's registration-gate outcome renders and whether it
 * counts toward doctor's found/fixed/remaining summary (flair#721). No fs,
 * no network, no crypto — the actual signed fetches (checkAgentRegistered,
 * authFetch) stay in src/cli.ts, same split as the rest of doctor-client.ts.
 */

import { describe, test, expect } from "bun:test";
import { planAgentIterations, describeAgentGateFinding } from "../../src/doctor-client.ts";

describe("planAgentIterations", () => {
  test("no --agent, no keys → empty list (the zero-keys fallback path)", () => {
    expect(planAgentIterations([], undefined)).toEqual([]);
  });

  test("no --agent, one key → that one id (the common single-agent install)", () => {
    expect(planAgentIterations(["local"], undefined)).toEqual(["local"]);
  });

  test("no --agent, multiple keys → every id, sorted for deterministic output", () => {
    expect(planAgentIterations(["zeta", "alpha", "mid"], undefined)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("--agent given → exactly that one id, regardless of what's in keysDir", () => {
    expect(planAgentIterations(["local", "ci-bot"], "ci-bot")).toEqual(["ci-bot"]);
  });

  test("--agent given but NOT among the enumerated keys → still just that id (filter, not a membership check)", () => {
    // Unchanged pre-#722 semantics: --agent tries a single signed identity
    // even if doctor never found a matching key on disk — the registration
    // gate (checkAgentRegistered) is what reports "no local key", not this
    // planning step.
    expect(planAgentIterations(["local"], "someone-else")).toEqual(["someone-else"]);
  });

  test("--agent given, zero keys on disk → still just that id", () => {
    expect(planAgentIterations([], "solo")).toEqual(["solo"]);
  });

  test("does not mutate the input array", () => {
    const input = ["b", "a"];
    planAgentIterations(input, undefined);
    expect(input).toEqual(["b", "a"]);
  });
});

describe("describeAgentGateFinding", () => {
  test("registered → null (caller proceeds with the real verified read)", () => {
    expect(describeAgentGateFinding("local", "registered")).toBeNull();
  });

  test("no-key → warn finding, not an issue, no fix hint", () => {
    const f = describeAgentGateFinding("ci-bot", "no-key", "no local key for agent 'ci-bot' to sign the check");
    expect(f).not.toBeNull();
    expect(f!.icon).toBe("warn");
    expect(f!.isIssue).toBe(false);
    expect(f!.fixHint).toBeUndefined();
    expect(f!.message).toContain("ci-bot");
    expect(f!.message).toContain("no local key for agent 'ci-bot'");
  });

  test("no-key without a detail string still renders a usable message", () => {
    const f = describeAgentGateFinding("ci-bot", "no-key");
    expect(f).not.toBeNull();
    expect(f!.message).toContain("no local key for 'ci-bot'");
  });

  test("not-registered → error finding, IS an issue, carries the `flair agent add` fix hint", () => {
    const f = describeAgentGateFinding("stray", "not-registered");
    expect(f).not.toBeNull();
    expect(f!.icon).toBe("error");
    expect(f!.isIssue).toBe(true);
    expect(f!.fixHint).toBe("flair agent add stray");
    expect(f!.message).toContain("stray");
    expect(f!.message).toContain("NOT registered");
  });

  test("unreachable → warn finding, not an issue (matches Client integration section's treatment of the same state)", () => {
    const f = describeAgentGateFinding("local", "unreachable", "instance unreachable: fetch failed");
    expect(f).not.toBeNull();
    expect(f!.icon).toBe("warn");
    expect(f!.isIssue).toBe(false);
    expect(f!.fixHint).toBeUndefined();
    expect(f!.message).toContain("could not verify");
    expect(f!.message).toContain("local");
  });

  test("only 'not-registered' counts as an issue — no-key and unreachable never do", () => {
    const states: Array<["registered" | "not-registered" | "unreachable" | "no-key", boolean]> = [
      ["registered", false], // null, not even a finding
      ["no-key", false],
      ["not-registered", true],
      ["unreachable", false],
    ];
    for (const [state, expectIssue] of states) {
      const f = describeAgentGateFinding("x", state);
      expect(f?.isIssue ?? false).toBe(expectIssue);
    }
  });
});
