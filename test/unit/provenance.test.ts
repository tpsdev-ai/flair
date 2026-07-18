/**
 * provenance.test.ts — resources/provenance.ts's buildProvenance().
 *
 * Pure-function unit coverage for the write-time provenance stamp
 * (memory-provenance slice 1; `claimed.client` added by flair#718
 * authorship-provenance). No Harper mocking needed — buildProvenance takes
 * plain values and returns a JSON string.
 *
 * Covers:
 *   - verified.agentId/timestamp derivation from the auth verdict.
 *   - claimed.model / claimed.client: sanitize (string-only, control-char
 *     strip, trim, 200-char cap, drop-if-empty-after-sanitize) — SAME
 *     discipline for both fields (Sherlock flair#718: the model cap was
 *     previously truthiness-only; folded into the shared sanitizer here).
 *   - `claimed` key omitted entirely when both are absent.
 *   - claimedClient is a WRITE-BODY-ONLY input: it must never leak into the
 *     output under its own name, and the stripping of it from the persisted
 *     row is asserted at the Memory.ts/Relationship.ts call sites (see
 *     memory-claimed-client-strip.test.ts / relationship's own coverage).
 */
import { describe, it, expect } from "bun:test";
import { buildProvenance } from "../../resources/provenance.ts";
import type { AgentAuthVerdict } from "../../resources/agent-auth.ts";

const AGENT: AgentAuthVerdict = { kind: "agent", agentId: "agt_alice", isAdmin: false };
const INTERNAL: AgentAuthVerdict = { kind: "internal" };
const NOW = "2026-07-18T00:00:00.000Z";

function parse(json: string): any {
  return JSON.parse(json);
}

describe("buildProvenance — verified fields", () => {
  it("stamps verified.agentId from the auth verdict (kind: agent)", () => {
    const prov = parse(buildProvenance(AGENT, NOW, {}));
    expect(prov.v).toBe(1);
    expect(prov.verified.agentId).toBe("agt_alice");
    expect(prov.verified.timestamp).toBe(NOW);
  });

  it("stamps verified.agentId = null for kind: internal (never throws)", () => {
    const prov = parse(buildProvenance(INTERNAL, NOW, {}));
    expect(prov.verified.agentId).toBeNull();
    expect(prov.verified.timestamp).toBe(NOW);
  });

  it("verified.agentId NEVER reads from the content body, even if forged", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { agentId: "agt_forged_victim" }));
    expect(prov.verified.agentId).toBe("agt_alice");
  });
});

describe("buildProvenance — claimed key omission", () => {
  it("omits `claimed` entirely when neither model nor client is present", () => {
    const prov = parse(buildProvenance(AGENT, NOW, {}));
    expect(prov.claimed).toBeUndefined();
    expect("claimed" in prov).toBe(false);
  });

  it("omits `claimed` when model/client are present but non-string", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: 12345, claimedClient: { nested: true } }));
    expect("claimed" in prov).toBe(false);
  });

  it("omits `claimed` when model/client are empty/whitespace-only strings", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: "   ", claimedClient: "\t\n" }));
    expect("claimed" in prov).toBe(false);
  });
});

describe("buildProvenance — claimed.client (flair#718)", () => {
  it("passthrough from content.claimedClient (a DISTINCT body field name from the output key)", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { claimedClient: "claude-code" }));
    expect(prov.claimed).toEqual({ client: "claude-code" });
  });

  it("content.client (wrong field name) is NOT picked up — only claimedClient", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { client: "codex" }));
    expect("claimed" in prov).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { claimedClient: "  gemini  " }));
    expect(prov.claimed.client).toBe("gemini");
  });

  it("strips control characters (C0 + DEL)", () => {
    const withControls = "cur\x00sor\x1F\x7F";
    const prov = parse(buildProvenance(AGENT, NOW, { claimedClient: withControls }));
    expect(prov.claimed.client).toBe("cursor");
  });

  it("length-caps at 200 chars (truncates, does not drop)", () => {
    const long = "x".repeat(250);
    const prov = parse(buildProvenance(AGENT, NOW, { claimedClient: long }));
    expect(prov.claimed.client).toBe("x".repeat(200));
    expect(prov.claimed.client.length).toBe(200);
  });

  it("drops (claimed omitted) when the value is entirely control chars", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { claimedClient: "\x00\x01\x02" }));
    expect("claimed" in prov).toBe(false);
  });
});

describe("buildProvenance — claimed.model (Sherlock flair#718 refinement: same cap+sanitize as client)", () => {
  it("passthrough from content.model, unchanged for a normal value", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: "claude-opus-4-7" }));
    expect(prov.claimed).toEqual({ model: "claude-opus-4-7" });
  });

  it("length-caps at 200 chars (previously unbounded — truthiness-only check)", () => {
    const long = "m".repeat(500);
    const prov = parse(buildProvenance(AGENT, NOW, { model: long }));
    expect(prov.claimed.model).toBe("m".repeat(200));
  });

  it("trims and strips control characters, same as claimed.client", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: "  gpt\x00-5  " }));
    expect(prov.claimed.model).toBe("gpt-5");
  });

  it("drops when non-string", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: 42 }));
    expect("claimed" in prov).toBe(false);
  });
});

describe("buildProvenance — both fields together", () => {
  it("stamps both model and client when both present", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: "claude-opus-4-7", claimedClient: "claude-code" }));
    expect(prov.claimed).toEqual({ model: "claude-opus-4-7", client: "claude-code" });
  });

  it("stamps only client when model is absent", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { claimedClient: "codex" }));
    expect(prov.claimed).toEqual({ client: "codex" });
    expect(prov.claimed.model).toBeUndefined();
  });

  it("stamps only model when client is absent", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: "gpt-5" }));
    expect(prov.claimed).toEqual({ model: "gpt-5" });
    expect(prov.claimed.client).toBeUndefined();
  });
});
