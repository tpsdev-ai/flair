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
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ─── The gap a review called "sufficient" ────────────────────────────────────
//
// The first version of this fix set `currentStep` before the four ASYNC
// operations only. Four steps run before that — local-origin-check, signing-key,
// config-block, idp-credentials — during which `currentStep` was undefined and
// the catch fell back to the literal "signing-key".
//
// So a throw during idp-credentials would have been reported as a signing-key
// failure: the same defect class this PR fixes, with a different wrong answer.
// A partial fix for a defect class is how the class survives.
describe("every step sets the tracker — no window attributes a throw elsewhere", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "..", "src", "lib", "mcp-enable.ts"),
    "utf8",
  );

  // Extract the EnableStepName union members — the authoritative list of steps.
  // Scanning the TYPE rather than the call sites is what makes this a
  // completeness check: a step you added to the union but never tracked shows up
  // here, whereas scanning calls could only ever find steps that already exist.
  const unionBody = src.slice(
    src.indexOf("export type EnableStepName ="),
    src.indexOf(";", src.indexOf("export type EnableStepName =")),
  );
  const declared = [...unionBody.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const tracked = new Set(
    [...src.matchAll(/currentStep\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
  );

  test("the union scan actually found the steps (guards the two above it)", () => {
    // Without this, a changed type declaration silently yields `declared: []`,
    // and BOTH tests below pass by having nothing to check — the vacuum this
    // file exists to prevent, one level up.
    expect(declared.length).toBeGreaterThanOrEqual(8);
    expect(declared).toContain("identity-mapping");
  });

  test("every declared step assigns currentStep", () => {
    // Add a step to the union, forget the tracker, and a throw inside it lands
    // on whichever step was set last — the original bug, re-entering through
    // the one door the type system does not watch.
    const untracked = declared.filter((s) => !tracked.has(s));
    expect(untracked).toEqual([]);
  });

  test("push takes no step name — a wrong one must stay unrepresentable", () => {
    // The fix for #1087 was not the counting check; it was deleting push's step
    // parameter so the name is READ from currentStep. That removes wrong-name,
    // and reviewers Kern and Sherlock split on whether a comment was enough to
    // hold the line. It is not: this asserts the shape instead.
    //
    // Sherlock's runtime assertion (`if (currentStep !== step) throw`) was the
    // other candidate. It validates a parameter that no longer needs to exist,
    // and it adds a throw path to the reporting code inside the catch block that
    // does the reporting. Removing the parameter beats checking it.
    const named = [...src.matchAll(/(?<!steps\.)push\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(named).toEqual([]);
  });

  test("that shape check can see a reintroduced name (positive control)", () => {
    const sample = 'push("verify-2", true, "x"); push("odd_name", true, "y");';
    const seen = [...sample.matchAll(/(?<!steps\.)push\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(seen).toEqual(["verify-2", "odd_name"]);
  });
});
