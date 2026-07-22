import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Per-resource allow* WIRING guard (structural). Harper injects `Resource` as a
// runtime global rather than an npm export, so resource classes can't be
// instantiated in a bun unit context (the ESM linker rejects `import { Resource }`).
// So we verify the wiring at the source level: every admin-only resource must gate
// on allowAdmin (which denies non-admin agents) and every agent-facing resource on
// allowVerified. The HELPER BEHAVIOR is truth-tabled in allow-helpers.test.ts, and
// real-Harper per-resource behavior (admin-only denial, anonymous denial,
// cross-agent ownership) is in flair-agent-deelevation.test.ts. This catches the
// dangerous mis-wire: an admin-only endpoint dropped onto allowVerified, which
// would let any verified agent call it.

const SRC = (f: string) => readFileSync(join(import.meta.dir, "..", "..", "resources", f), "utf8");

const ADMIN_ONLY = ["AgentSeed.ts", "MemoryReindex.ts", "OrgEventMaintenance.ts", "MemoryDedupStats.ts"];
const AGENT_FACING = [
  "MemoryBootstrap.ts", "MemoryFeed.ts", "MemoryReflect.ts", "MemoryConsolidate.ts",
  "SoulFeed.ts", "OrgEventCatchup.ts", "SemanticSearch.ts", "WorkspaceLatest.ts",
];

describe("admin-only resources gate on allowAdmin (never allowVerified)", () => {
  for (const f of ADMIN_ONLY) {
    it(`${f} uses allowAdmin and not allowVerified`, () => {
      const src = SRC(f);
      expect(src.includes("allowAdmin("), `${f} must gate on allowAdmin`).toBe(true);
      expect(src.includes("allowVerified("), `${f} must NOT use allowVerified (would permit non-admin agents)`).toBe(false);
    });
  }
});

describe("agent-facing resources gate on allowVerified", () => {
  for (const f of AGENT_FACING) {
    it(`${f} uses allowVerified`, () => {
      expect(SRC(f).includes("allowVerified("), `${f} must gate on allowVerified`).toBe(true);
    });
  }
});

describe("every gated resource actually defines an allow* method", () => {
  for (const f of [...ADMIN_ONLY, ...AGENT_FACING]) {
    it(`${f} defines at least one allow* method`, () => {
      expect(/async\s+allow(Create|Read|Update|Delete)\s*\(/.test(SRC(f)), `${f} has no allow* method`).toBe(true);
    });
  }
});
