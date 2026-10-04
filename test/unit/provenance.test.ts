/**
 * provenance.test.ts — resources/provenance.ts's buildProvenance().
 *
 * Pure-function unit coverage for the write-time provenance stamp
 * (memory-provenance slice 1; `claimed.client` added by flair#718
 * authorship-provenance; `claimed.createdAt` + server-stamped
 * `verified.timestamp` added by flair#1960). No Harper mocking needed —
 * buildProvenance takes plain values and returns a JSON string.
 *
 * Covers:
 *   - verified.agentId derivation from the auth verdict; verified.timestamp /
 *     verified.receivedAt are the SERVER write instant (flair#1960/#1940 A4),
 *     never the caller-supplied createdAt.
 *   - claimed.createdAt: the caller's createdAt claim, sanitized like the other
 *     claims (string-only, control-char strip, trim, 200-char cap,
 *     drop-if-empty).
 *   - claimed.model / claimed.client: sanitize (string-only, control-char
 *     strip, trim, 200-char cap, drop-if-empty-after-sanitize) — SAME
 *     discipline for both fields (Sherlock flair#718: the model cap was
 *     previously truthiness-only; folded into the shared sanitizer here).
 *   - `claimed` key omitted entirely only when createdAt, model and client are
 *     all absent after sanitization.
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
const PAST = "2001-01-01T00:00:00.000Z";

function parse(json: string): any {
  return JSON.parse(json);
}

describe("buildProvenance — verified fields", () => {
  it("stamps verified.agentId from the auth verdict (kind: agent)", () => {
    const prov = parse(buildProvenance(AGENT, NOW, {}));
    expect(prov.v).toBe(1);
    expect(prov.verified.agentId).toBe("agt_alice");
  });

  it("stamps verified.agentId = null for kind: internal (never throws)", () => {
    const prov = parse(buildProvenance(INTERNAL, NOW, {}));
    expect(prov.verified.agentId).toBeNull();
    expect(typeof prov.verified.timestamp).toBe("string");
  });

  it("verified.agentId NEVER reads from the content body, even if forged", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { agentId: "agt_forged_victim" }));
    expect(prov.verified.agentId).toBe("agt_alice");
  });
});

describe("flair#1960 — verified.timestamp is the SERVER write instant, never the caller's createdAt", () => {
  it("stamps verified.timestamp from the server clock, NOT the caller-supplied createdAt", () => {
    const before = Date.now();
    const prov = parse(buildProvenance(AGENT, PAST, {}));
    expect(prov.verified.timestamp).not.toBe(PAST);
    const stamped = Date.parse(prov.verified.timestamp);
    expect(Number.isFinite(stamped)).toBe(true);
    expect(stamped).toBeGreaterThanOrEqual(before - 5000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it("shares exactly ONE clock read between verified.timestamp and verified.receivedAt", () => {
    // flair#1960 r2: use an INJECTED, counting-and-ADVANCING fake clock. The
    // second read returns a DIFFERENT value, so `timestamp === receivedAt` can
    // only hold if buildProvenance read the clock exactly once. Two wall-clock
    // reads almost always agree (a double-read matched on 9,993/10,000 pairs),
    // so the old string-equality-only assertion did NOT prove a single read —
    // this one fails deterministically (calls === 2, values differ) if a second
    // read is ever added.
    let calls = 0;
    const base = Date.parse("2026-07-18T00:00:00.000Z");
    const clock = () => new Date(base + calls++ * 1000);
    const prov = parse(buildProvenance(AGENT, PAST, {}, clock));
    expect(calls).toBe(1);
    expect(prov.verified.timestamp).toBe(new Date(base).toISOString());
    expect(prov.verified.receivedAt).toBe(new Date(base).toISOString());
    expect(prov.verified.timestamp).toBe(prov.verified.receivedAt);
  });

  it("records the caller's createdAt as a CLAIM under claimed.createdAt, distinct from the verified stamp", () => {
    const prov = parse(buildProvenance(AGENT, PAST, {}));
    expect(prov.claimed.createdAt).toBe(PAST);
    expect(prov.verified.timestamp).not.toBe(prov.claimed.createdAt);
  });

  it("sanitizes the claimed createdAt: control chars stripped, absurd length capped at 200", () => {
    const capped = parse(buildProvenance(AGENT, "2".repeat(300), {}));
    expect(capped.claimed.createdAt.length).toBe(200);
    const controls = parse(buildProvenance(AGENT, "20\x0026\x1F-01", {}));
    expect(controls.claimed.createdAt).toBe("2026-01");
  });

  it("drops an all-control-chars claimed createdAt (claimed omitted with no model/client)", () => {
    const prov = parse(buildProvenance(AGENT, "\x00\x01\x02", {}));
    expect("claimed" in prov).toBe(false);
  });
});

describe("buildProvenance — claimed key omission", () => {
  it("carries only claimed.createdAt when neither model nor client is present", () => {
    const prov = parse(buildProvenance(AGENT, NOW, {}));
    expect(prov.claimed).toEqual({ createdAt: NOW });
    expect(prov.claimed.model).toBeUndefined();
    expect(prov.claimed.client).toBeUndefined();
  });

  it("does not pick up non-string model/client (dropped, not coerced)", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: 12345, claimedClient: { nested: true } }));
    expect(prov.claimed).toEqual({ createdAt: NOW });
  });

  it("drops empty/whitespace-only model/client", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: "   ", claimedClient: "\t\n" }));
    expect(prov.claimed).toEqual({ createdAt: NOW });
  });

  it("omits `claimed` entirely when createdAt and model/client are ALL absent after sanitization", () => {
    const prov = parse(buildProvenance(AGENT, "\x00", {}));
    expect("claimed" in prov).toBe(false);
  });
});

describe("buildProvenance — claimed.client (flair#718)", () => {
  it("passthrough from content.claimedClient (a DISTINCT body field name from the output key)", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { claimedClient: "claude-code" }));
    expect(prov.claimed).toEqual({ createdAt: NOW, client: "claude-code" });
  });

  it("content.client (wrong field name) is NOT picked up — only claimedClient", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { client: "codex" }));
    expect(prov.claimed.client).toBeUndefined();
    expect(prov.claimed).toEqual({ createdAt: NOW });
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

  it("drops the client claim (not the whole claimed object) when the value is entirely control chars", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { claimedClient: "\x00\x01\x02" }));
    expect(prov.claimed.client).toBeUndefined();
    expect(prov.claimed).toEqual({ createdAt: NOW });
  });
});

describe("buildProvenance — claimed.model (Sherlock flair#718 refinement: same cap+sanitize as client)", () => {
  it("passthrough from content.model, unchanged for a normal value", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: "claude-opus-4-7" }));
    expect(prov.claimed).toEqual({ createdAt: NOW, model: "claude-opus-4-7" });
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
    expect(prov.claimed.model).toBeUndefined();
  });
});

describe("buildProvenance — both fields together", () => {
  it("stamps both model and client when both present", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: "claude-opus-4-7", claimedClient: "claude-code" }));
    expect(prov.claimed).toEqual({ createdAt: NOW, model: "claude-opus-4-7", client: "claude-code" });
  });

  it("stamps only client when model is absent", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { claimedClient: "codex" }));
    expect(prov.claimed).toEqual({ createdAt: NOW, client: "codex" });
    expect(prov.claimed.model).toBeUndefined();
  });

  it("stamps only model when client is absent", () => {
    const prov = parse(buildProvenance(AGENT, NOW, { model: "gpt-5" }));
    expect(prov.claimed).toEqual({ createdAt: NOW, model: "gpt-5" });
    expect(prov.claimed.client).toBeUndefined();
  });
});

describe("flair#1940 A4 — server receipt time", () => {
  it("stamps receivedAt from the SERVER clock, and IGNORES a client-supplied receivedAt", () => {
    const before = Date.now();
    const p = parse(buildProvenance(AGENT, NOW, { receivedAt: "1999-01-01T00:00:00.000Z" }));
    expect(typeof p.verified.receivedAt).toBe("string"); // assertion: present
    expect(p.verified.receivedAt).not.toBe("1999-01-01T00:00:00.000Z"); // assertion: the client value is ignored
    expect(new Date(p.verified.receivedAt).getTime()).toBeGreaterThanOrEqual(before - 5000); // server clock
  });
});
