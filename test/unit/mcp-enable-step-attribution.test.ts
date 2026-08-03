// flair#1087 — a failure must be attributed to the step that was RUNNING, not
// to the last step that succeeded.
//
// The observed output, enabling MCP against a hosted instance:
//
//     ✓ secrets-provisioning   ...apply these 5 vars via Fabric Studio, then re-run
//     ✗ secrets-provisioning   unexpected error: Identity mapping: ... (HTTP 404)
//
// Two results for ONE step name. The ✓ instructs several minutes of manual work
// in a web UI; the ✗ makes that work pointless. Read in order — which is how
// people read — you do the work first and then discover it was wasted.
//
// The cause was `steps[steps.length - 1].step` in the catch: the last COMPLETED
// step, not the failing one. identity-mapping threw; secrets-provisioning had
// just succeeded; the error was filed against secrets-provisioning.
import { describe, test, expect } from "bun:test";
import { enableMcp } from "../../src/lib/mcp-enable.js";

/** An ops API that answers 404 to everything — the shape that broke identity
 *  mapping in the field (calls hitting the served origin). */
const opsAlways404: typeof fetch = (async () =>
  new Response("Not found", { status: 404 })) as unknown as typeof fetch;

describe("enableMcp — the failed step is the one that ran, not the one before it", () => {
  test("an identity-mapping failure is reported against identity-mapping", async () => {
    const res = await enableMcp(
      {
        instance: "https://flair.example.harperfabric.com",
        adminUser: "admin",
        adminPass: "pw",
        idpProvider: "github",
        idpClientId: "id",
        idpClientSecret: "secret",
        idpSubject: "octocat",
        principal: "self",
        principalKind: "human",
        confirmSecretsApplied: true,
      } as any,
      { fetchImpl: opsAlways404 } as any,
    );

    expect(res.ok).toBe(false);
    // The whole point: NOT "secrets-provisioning".
    expect(res.failedStep).toBe("identity-mapping");
  });

  test("no step name carries both a pass and a failure in one run", async () => {
    const res = await enableMcp(
      {
        instance: "https://flair.example.harperfabric.com",
        adminUser: "admin",
        adminPass: "pw",
        idpProvider: "github",
        idpClientId: "id",
        idpClientSecret: "secret",
        idpSubject: "octocat",
        principal: "self",
        principalKind: "human",
        confirmSecretsApplied: true,
      } as any,
      { fetchImpl: opsAlways404 } as any,
    );

    const byName = new Map<string, Set<boolean>>();
    for (const s of res.steps ?? []) {
      if (!byName.has(s.step)) byName.set(s.step, new Set());
      byName.get(s.step)!.add(s.ok);
    }
    const contradictory = [...byName.entries()]
      .filter(([, outcomes]) => outcomes.size > 1)
      .map(([name]) => name);

    // A step that reports both ✓ and ✗ is un-skimmable: someone scanning for the
    // first ✗ finds a ✓ for that same name above it.
    expect(contradictory).toEqual([]);
  });
});
