/**
 * federation-pair-identity.test.ts — flair#822
 *
 * Hub `/FederationPair` must return `instance { id, publicKey }`. The spoke
 * must treat a missing publicKey as an error (or recover via
 * `/FederationInstance`), never store `""`.
 *
 * Pure helpers — no Harper. Handler wiring is asserted from source so a
 * revert of the call sites cannot silently restore `?? ""`.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pairResponseInstance,
  hubPeerFromPairResult,
  resolveHubPeerIdentity,
} from "../../src/lib/federation-pair-identity.ts";

const HUB_ID = "flair_hubdeadbeef";
const HUB_KEY = "dGVzdC1lZDI1NTE5LXB1YmtleS1iYXNlNjR1cmw";

describe("pairResponseInstance — hub /FederationPair body", () => {
  it("includes instance {id, publicKey} (and role when present)", () => {
    const result = pairResponseInstance({
      id: HUB_ID,
      publicKey: HUB_KEY,
      role: "hub",
      status: "active",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance).toEqual({ id: HUB_ID, publicKey: HUB_KEY, role: "hub" });
  });

  it("refuses a missing Instance row (the instance:null path)", () => {
    for (const row of [null, undefined, {}]) {
      const result = pairResponseInstance(row);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain("id or publicKey");
    }
  });

  it("refuses an Instance row with empty or whitespace publicKey", () => {
    for (const publicKey of ["", "   ", null, undefined, 0]) {
      const result = pairResponseInstance({ id: HUB_ID, publicKey, role: "hub" });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses an Instance row with empty id even when publicKey is present", () => {
    const result = pairResponseInstance({ id: "", publicKey: HUB_KEY });
    expect(result.ok).toBe(false);
  });

  it("trims id and publicKey", () => {
    const result = pairResponseInstance({ id: ` ${HUB_ID} `, publicKey: ` ${HUB_KEY} ` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.id).toBe(HUB_ID);
    expect(result.instance.publicKey).toBe(HUB_KEY);
  });
});

describe("hubPeerFromPairResult — spoke refuse-empty", () => {
  it("accepts a complete pair response", () => {
    const result = hubPeerFromPairResult({
      paired: true,
      instance: { id: HUB_ID, publicKey: HUB_KEY, role: "hub" },
    });
    expect(result).toEqual({ ok: true, peer: { id: HUB_ID, publicKey: HUB_KEY } });
  });

  it("refuses instance:null / omitted instance (never falls back to \"\")", () => {
    for (const body of [{ paired: true, instance: null }, { paired: true }, null, undefined, {}]) {
      const result = hubPeerFromPairResult(body);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("missing_public_key");
    }
  });

  it("refuses publicKey:\"\" and whitespace — the stored-empty-key defect", () => {
    for (const publicKey of ["", "   "]) {
      const result = hubPeerFromPairResult({
        instance: { id: HUB_ID, publicKey },
      });
      expect(result.ok).toBe(false);
    }
  });

  it("keeps a present publicKey even when id is missing (id falls back to \"hub\")", () => {
    const result = hubPeerFromPairResult({ instance: { publicKey: HUB_KEY } });
    expect(result).toEqual({ ok: true, peer: { id: "hub", publicKey: HUB_KEY } });
  });
});

describe("resolveHubPeerIdentity — pair first, then /FederationInstance", () => {
  it("uses the pair response when instance.publicKey is present", async () => {
    const resolved = await resolveHubPeerIdentity(
      { instance: { id: HUB_ID, publicKey: HUB_KEY } },
      { fetchInstance: async () => { throw new Error("must not fetch"); } },
    );
    expect(resolved).toEqual({
      ok: true,
      source: "pair",
      peer: { id: HUB_ID, publicKey: HUB_KEY },
    });
  });

  it("recovers via GET /FederationInstance when pair omitted the key", async () => {
    const resolved = await resolveHubPeerIdentity(
      { paired: true, instance: null },
      { fetchInstance: async () => ({ id: HUB_ID, publicKey: HUB_KEY, role: "hub" }) },
    );
    expect(resolved).toEqual({
      ok: true,
      source: "federation_instance",
      peer: { id: HUB_ID, publicKey: HUB_KEY },
    });
  });

  it("errors when pair and /FederationInstance both lack publicKey — never \"\"", async () => {
    const resolved = await resolveHubPeerIdentity(
      { instance: { id: "hub", publicKey: "" } },
      { fetchInstance: async () => ({ id: HUB_ID, publicKey: "" }) },
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("refusing to store an empty hub Peer key");
    expect(resolved.error).not.toContain('""');
  });

  it("errors when the fallback fetch throws or returns nothing", async () => {
    const thrown = await resolveHubPeerIdentity(
      { instance: null },
      { fetchInstance: async () => { throw new Error("403"); } },
    );
    expect(thrown.ok).toBe(false);

    const missing = await resolveHubPeerIdentity({ instance: null });
    expect(missing.ok).toBe(false);
  });
});

describe("wiring — hub and spoke call the identity contract (flair#822)", () => {
  const root = join(import.meta.dir, "../..");

  it("FederationPair.post uses pairResponseInstance and never returns instance:null", () => {
    const src = readFileSync(join(root, "resources/Federation.ts"), "utf8");
    expect(src).toContain("pairResponseInstance");
    expect(src).toContain("HUB_IDENTITY_INCOMPLETE");
    expect(src).toContain("id: ours.instance.id");
    expect(src).toContain("publicKey: ours.instance.publicKey");
    expect(src).not.toMatch(/instance:\s*ourInstance\s*\?/);
    expect(src).not.toMatch(/instance:\s*null/);
  });

  it("spoke pair writes resolvedHub.peer.publicKey and never ?? \"\"", () => {
    const src = readFileSync(join(root, "src/cli.ts"), "utf8");
    expect(src).toContain("resolveHubPeerIdentity");
    expect(src).toContain("resolvedHub.peer.publicKey");
    expect(src).toContain("resolvedHub.peer.id");
    expect(src).not.toMatch(/publicKey:\s*result\.instance\?\.publicKey\s*\?\?\s*""/);
  });
});
