/**
 * record-types-registry.test.ts — unit coverage for resources/record-types.ts
 * (record-types slice 2, flair#520).
 *
 * `resources/record-types.ts` has ZERO runtime imports (its only import is
 * `import type { ... }`, erased by bun's TS transpile — see that module's
 * header) so, unlike record-type-kit.test.ts / the five tables' own behavior
 * tests, this file needs NO `mock.module("@harperfast/harper", ...)` and can
 * import RECORD_TYPES directly.
 *
 * Three kinds of coverage:
 *   1. Shape/exhaustiveness — every entry's fields are present and valid
 *      per the RecordTypePolicy contract (catches a malformed future entry).
 *   2. Golden-value pinning — the FIVE CORE ENTRIES' policies, hardcoded
 *      here independently of resources/record-types.ts, must exactly match
 *      what resources/Memory.ts / Relationship.ts / WorkspaceState.ts /
 *      OrgEvent.ts / Soul.ts actually DO today (confirmed by reading each
 *      file directly — see this repo's flair#520 slice-2 report for the
 *      per-table trace). A registry edit that drifts from shipped behavior
 *      fails here even though nothing else in the suite would catch it.
 *   3. Drift tripwire — resource files draw their kit parameters (readScope
 *      mode/ownerField, attribution mode) FROM RECORD_TYPES.<Table>, not
 *      from hand-typed literals (record-types slice 2's "single source of
 *      truth" requirement). Verified via a SOURCE-TEXT scan of the five
 *      resource files, DELIBERATELY not by importing them: importing any of
 *      Memory.ts/Relationship.ts/WorkspaceState.ts/OrgEvent.ts/Soul.ts
 *      requires @harperfast/harper's `databases` proxy to resolve real
 *      table classes at module-eval time (`class X extends (databases as
 *      any).flair.X`) — without a `mock.module("@harperfast/harper", ...)`
 *      it throws immediately trying to boot a real Harper storage path
 *      (confirmed empirically: this file failed exactly that way on a first
 *      draft that imported Memory.ts directly). Standing up a compatible
 *      mock for all five tables in one file, in a suite where every one of
 *      them already has its OWN single-importer mock elsewhere in
 *      test/unit/, risks the exact cross-file module-cache collision
 *      test/unit/memory-soul-read-gate.test.ts's own header documents (bun
 *      runs every test/unit/ file in ONE process; a class's superclass
 *      reference is captured ONCE, at whichever file's mocked import wins
 *      the race). A source-text check needs no mock at all and directly
 *      answers the actual question ("does this file's code read the mode
 *      from RECORD_TYPES, or from a literal?") without that fragility.
 *      record-type-kit.test.ts separately covers the LOWER-LEVEL primitive
 *      this depends on: makeReadScope()'s returned resolver is now tagged
 *      with `.mode`/`.ownerField` (see that module's doc), exercised there
 *      against record-type-kit.test.ts's own existing minimal Harper mock.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECORD_TYPES,
  COMPOSITE_MCP_TOOLS,
  type RecordTypePolicy,
  type RecordTypeReadScopeMode,
  type RecordTypeIdentityMode,
  type RecordTypeFederation,
} from "../../resources/record-types.ts";

const RESOURCES_DIR = join(import.meta.dir, "..", "..", "resources");
const VALID_IDENTITY: RecordTypeIdentityMode[] = ["gated", "internal-only"];
const VALID_READ_SCOPE: RecordTypeReadScopeMode[] = ["owner-only", "open-within-org", "none"];
const VALID_ATTRIBUTION_MODES = ["validate-truthy", "validate-strict", "stamp-default", "stamp-strict"];
const VALID_FEDERATION: RecordTypeFederation[] = ["excluded", "included"];
const VALID_MCP_READ_VERBS = ["get", "search"];
const VALID_MCP_WRITE_VERBS = ["store", "delete", "update"];

// ─── 1. Shape / exhaustiveness ─────────────────────────────────────────────

describe("RECORD_TYPES — shape and exhaustiveness", () => {
  const entries = Object.entries(RECORD_TYPES) as Array<[string, RecordTypePolicy]>;

  it("registers exactly the five core tables (slice 2 scope — no more, no fewer)", () => {
    expect(Object.keys(RECORD_TYPES).sort()).toEqual(
      ["Memory", "OrgEvent", "Relationship", "Soul", "WorkspaceState"].sort(),
    );
  });

  it.each(entries)("%s: table field equals its own registry key", (key, policy) => {
    expect(policy.table).toBe(key);
  });

  it.each(entries)("%s: ownerField is a non-empty string", (_key, policy) => {
    expect(typeof policy.ownerField).toBe("string");
    expect(policy.ownerField.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s: identity is a valid mode", (_key, policy) => {
    expect(VALID_IDENTITY).toContain(policy.identity);
  });

  it.each(entries)("%s: readScope is a valid mode", (_key, policy) => {
    expect(VALID_READ_SCOPE).toContain(policy.readScope);
  });

  it.each(entries)("%s: attribution only carries post/put, each a valid AttributionMode", (_key, policy) => {
    const keys = Object.keys(policy.attribution);
    for (const k of keys) expect(["post", "put"]).toContain(k);
    if (policy.attribution.post !== undefined) expect(VALID_ATTRIBUTION_MODES).toContain(policy.attribution.post);
    if (policy.attribution.put !== undefined) expect(VALID_ATTRIBUTION_MODES).toContain(policy.attribution.put);
  });

  it.each(entries)("%s: provenance is a boolean", (_key, policy) => {
    expect(typeof policy.provenance).toBe("boolean");
  });

  it.each(entries)("%s: embedding, if present, has a non-empty field and boolean exposedSearch", (_key, policy) => {
    if (policy.embedding === undefined) return;
    expect(typeof policy.embedding.field).toBe("string");
    expect(policy.embedding.field.length).toBeGreaterThan(0);
    expect(typeof policy.embedding.exposedSearch).toBe("boolean");
  });

  it.each(entries)("%s: remEligible MUST be the literal false (v1 reserved no-op)", (_key, policy) => {
    expect(policy.remEligible).toBe(false);
  });

  it.each(entries)("%s: federation is a valid mode", (_key, policy) => {
    expect(VALID_FEDERATION).toContain(policy.federation);
  });

  it.each(entries)("%s: mcp, if present, has a valid toolPrefix and verb arrays", (_key, policy) => {
    if (policy.mcp === undefined) return;
    expect(typeof policy.mcp.toolPrefix).toBe("string");
    expect(policy.mcp.toolPrefix.length).toBeGreaterThan(0);
    for (const v of policy.mcp.readVerbs) expect(VALID_MCP_READ_VERBS).toContain(v);
    for (const v of policy.mcp.writeVerbs) expect(VALID_MCP_WRITE_VERBS).toContain(v);
  });

  it("Relationship has no mcp field (no MCP tool today — absent means no exposure)", () => {
    expect(RECORD_TYPES.Relationship.mcp).toBeUndefined();
  });
});

// ─── 2. Runtime immutability ────────────────────────────────────────────────

describe("RECORD_TYPES — deep-frozen (static-registry invariant backstop)", () => {
  it("the top-level map is frozen", () => {
    expect(Object.isFrozen(RECORD_TYPES)).toBe(true);
  });

  it("every entry object is frozen", () => {
    for (const policy of Object.values(RECORD_TYPES)) expect(Object.isFrozen(policy)).toBe(true);
  });

  it("nested attribution/embedding objects are frozen", () => {
    expect(Object.isFrozen(RECORD_TYPES.Memory.attribution)).toBe(true);
    expect(Object.isFrozen(RECORD_TYPES.Memory.embedding)).toBe(true);
  });

  it("a mutation attempt throws (strict-mode ES module)", () => {
    expect(() => {
      (RECORD_TYPES.Memory as any).readScope = "owner-only";
    }).toThrow();
  });
});

// ─── 3. Golden-value pin — registry must match shipped behavior exactly ────

describe("RECORD_TYPES — golden values (must match each table's current shipped behavior)", () => {
  it("Memory: open-within-org, validate-truthy on post+put, provenance, embedding.content, federated", () => {
    expect(RECORD_TYPES.Memory).toEqual({
      table: "Memory",
      ownerField: "agentId",
      identity: "gated",
      readScope: "open-within-org",
      attribution: { post: "validate-truthy", put: "validate-truthy" },
      provenance: true,
      embedding: { field: "content", exposedSearch: true },
      remEligible: false,
      federation: "included",
      mcp: { toolPrefix: "memory", readVerbs: ["get", "search"], writeVerbs: ["store", "delete", "update"] },
    });
  });

  it("Relationship: owner-only, stamp-strict on put only (no post override), provenance, federated", () => {
    expect(RECORD_TYPES.Relationship).toEqual({
      table: "Relationship",
      ownerField: "agentId",
      identity: "gated",
      readScope: "owner-only",
      attribution: { put: "stamp-strict" },
      provenance: true,
      remEligible: false,
      federation: "included",
    });
  });

  it("WorkspaceState: owner-only, stamp-default on post / validate-strict on put, no provenance, not federated", () => {
    expect(RECORD_TYPES.WorkspaceState).toEqual({
      table: "WorkspaceState",
      ownerField: "agentId",
      identity: "gated",
      readScope: "owner-only",
      attribution: { post: "stamp-default", put: "validate-strict" },
      provenance: false,
      remEligible: false,
      federation: "excluded",
      mcp: { toolPrefix: "flair_workspace", readVerbs: [], writeVerbs: ["store"] },
    });
  });

  it("OrgEvent: unscoped reads (authorId ownerField), stamp-default on post / validate-strict on put, no provenance, not federated", () => {
    expect(RECORD_TYPES.OrgEvent).toEqual({
      table: "OrgEvent",
      ownerField: "authorId",
      identity: "gated",
      readScope: "none",
      attribution: { post: "stamp-default", put: "validate-strict" },
      provenance: false,
      remEligible: false,
      federation: "excluded",
      mcp: { toolPrefix: "flair_orgevent", readVerbs: [], writeVerbs: ["store"] },
    });
  });

  it("Soul: unscoped reads, validate-truthy on post+put (shared enforceWriteAuth), no provenance, federated", () => {
    expect(RECORD_TYPES.Soul).toEqual({
      table: "Soul",
      ownerField: "agentId",
      identity: "gated",
      readScope: "none",
      attribution: { post: "validate-truthy", put: "validate-truthy" },
      provenance: false,
      remEligible: false,
      federation: "included",
      mcp: { toolPrefix: "soul", readVerbs: ["get"], writeVerbs: ["store"] },
    });
  });
});

// ─── 3b. MCP surface — golden-value pins (slice 3, flair#520) ─────────────
//
// The "no entry sets mcp" shape-only assertion from slice 2 is gone — slice
// 3's design round (Kern APPROVE all four asks, Sherlock APPROVE with the
// COMPOSITE_MCP_TOOLS-relocation refinement) backfilled `mcp` on four of the
// five entries and added the composite allowlist. These pins are the same
// discipline as section 3 above: hardcoded independently of
// resources/record-types.ts, so a registry edit that drifts from the
// reviewed, shipped MCP surface fails here even though the bidirectional
// enforcement lives in test/unit/mcp-surface-tripwire.test.ts, not this file.

describe("RECORD_TYPES.<Table>.mcp — golden values (backfilled surface, slice 3)", () => {
  it("Memory: get/search reads, store/delete/update writes", () => {
    expect(RECORD_TYPES.Memory.mcp).toEqual({
      toolPrefix: "memory",
      readVerbs: ["get", "search"],
      writeVerbs: ["store", "delete", "update"],
    });
  });

  it("Soul: get read, store write", () => {
    expect(RECORD_TYPES.Soul.mcp).toEqual({
      toolPrefix: "soul",
      readVerbs: ["get"],
      writeVerbs: ["store"],
    });
  });

  it("WorkspaceState: no reads, store write", () => {
    expect(RECORD_TYPES.WorkspaceState.mcp).toEqual({
      toolPrefix: "flair_workspace",
      readVerbs: [],
      writeVerbs: ["store"],
    });
  });

  it("OrgEvent: no reads, store write", () => {
    expect(RECORD_TYPES.OrgEvent.mcp).toEqual({
      toolPrefix: "flair_orgevent",
      readVerbs: [],
      writeVerbs: ["store"],
    });
  });

  it("Relationship: mcp absent (no MCP tool today)", () => {
    expect(RECORD_TYPES.Relationship.mcp).toBeUndefined();
  });
});

describe("COMPOSITE_MCP_TOOLS — golden-value pin (slice 3, flair#520)", () => {
  it("pins the exact three composite tool names, in order", () => {
    expect(COMPOSITE_MCP_TOOLS).toEqual(["bootstrap", "attention", "record_usage"]);
  });

  it("is deep-frozen (static-registry invariant, same as RECORD_TYPES)", () => {
    expect(Object.isFrozen(COMPOSITE_MCP_TOOLS)).toBe(true);
  });
});

// ─── 4. Drift tripwire — resource files draw params FROM the registry ─────

describe("Drift tripwire — the five resource classes wire their kit parameters from RECORD_TYPES, not inline literals", () => {
  const files: Record<string, string> = {
    Memory: readFileSync(join(RESOURCES_DIR, "Memory.ts"), "utf8"),
    Relationship: readFileSync(join(RESOURCES_DIR, "Relationship.ts"), "utf8"),
    WorkspaceState: readFileSync(join(RESOURCES_DIR, "WorkspaceState.ts"), "utf8"),
    OrgEvent: readFileSync(join(RESOURCES_DIR, "OrgEvent.ts"), "utf8"),
    Soul: readFileSync(join(RESOURCES_DIR, "Soul.ts"), "utf8"),
  };

  it.each(Object.entries(files))("%s: imports RECORD_TYPES from ./record-types.js", (_table, source) => {
    expect(source).toMatch(/import\s*\{\s*RECORD_TYPES\s*\}\s*from\s*"\.\/record-types\.js"/);
  });

  it.each(
    Object.entries(files).filter(([table]) => RECORD_TYPES[table as keyof typeof RECORD_TYPES].readScope !== "none"),
  )("%s: makeReadScope() is called with RECORD_TYPES.<Table>.readScope/.ownerField, not a literal mode string", (table, source) => {
    expect(source).toContain(`makeReadScope(RECORD_TYPES.${table}.readScope, RECORD_TYPES.${table}.ownerField)`);
    // No hardcoded mode literal passed directly to makeReadScope anywhere in the file.
    expect(source).not.toMatch(/makeReadScope\(\s*"(owner-only|open-within-org)"/);
  });

  it.each(
    Object.entries(files).filter(([table]) => RECORD_TYPES[table as keyof typeof RECORD_TYPES].readScope === "none"),
  )("%s: readScope 'none' — no makeReadScope() call at all (matches the no-override reality)", (_table, source) => {
    expect(source).not.toContain("makeReadScope(");
  });

  it.each(Object.entries(files))("%s: no stampAttribution() call passes a hardcoded mode literal", (_table, source) => {
    // stampAttribution's 4th positional arg (the AttributionMode) must never
    // be a bare string literal — it must come from RECORD_TYPES.<Table>.attribution.*.
    expect(source).not.toMatch(/stampAttribution\([^)]*"(validate-truthy|validate-strict|stamp-default|stamp-strict)"/);
  });

  it.each(entries("Memory", "post", "put"))("Memory: stampAttribution draws mode %s from RECORD_TYPES.Memory.attribution.%s", (method) => {
    expect(files.Memory).toContain(`RECORD_TYPES.Memory.attribution.${method}`);
  });

  it.each(entries("Relationship", "put"))("Relationship: stampAttribution draws mode from RECORD_TYPES.Relationship.attribution.%s", (method) => {
    expect(files.Relationship).toContain(`RECORD_TYPES.Relationship.attribution.${method}`);
  });
  it("Relationship: has no post() override wired to stampAttribution (attribution.post is intentionally absent)", () => {
    expect(RECORD_TYPES.Relationship.attribution.post).toBeUndefined();
  });

  it.each(entries("WorkspaceState", "post", "put"))("WorkspaceState: stampAttribution draws mode %s from RECORD_TYPES.WorkspaceState.attribution.%s", (method) => {
    expect(files.WorkspaceState).toContain(`RECORD_TYPES.WorkspaceState.attribution.${method}`);
  });

  it.each(entries("OrgEvent", "post", "put"))("OrgEvent: stampAttribution draws mode %s from RECORD_TYPES.OrgEvent.attribution.%s", (method) => {
    expect(files.OrgEvent).toContain(`RECORD_TYPES.OrgEvent.attribution.${method}`);
  });

  it("Soul: enforceWriteAuth (shared by post()+put()) draws mode from RECORD_TYPES.Soul.attribution.post", () => {
    expect(files.Soul).toContain("RECORD_TYPES.Soul.attribution.post");
  });

  function entries(_table: string, ...methods: string[]): string[][] {
    return methods.map((m) => [m]);
  }
});
