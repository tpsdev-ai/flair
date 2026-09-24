/**
 * skill-provenance.test.ts — flair#1433 fails-first gates.
 *
 * Check (1): register a skill from a `/tmp` path → registration FAILS and
 * names the path. Against main, Soul/bootstrap accepted
 * `/tmp/harperfast-skills-inspect/...` as a durable source.
 *
 * Check (2): two conflicting skills at equal priority (same name) → outcome
 * is deterministic and stated. Asserting "a conflict is reported" is not
 * enough; main already reports `[SKILL_CONFLICT]` and loads both.
 *
 * Check (3): negative control — a normally-installed, non-conflicting skill
 * loads silently (no SKILL_CONFLICT, no refusal).
 *
 * Check (4): two *different* names at the same priority both load, with no
 * `SKILL_CONFLICT` marker on either. That is the live #1433 payload shape
 * (`harper-best-practices` and `harperfast-skills`). Main's detector flags
 * same-priority rather than same-name, so that marker was a false positive;
 * this check must fail against main.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  registerSkillAssignment,
  refuseSkillAssignmentWrite,
  resolveActiveSkills,
  isDurableSkillSource,
  filesystemPathFromSkillSource,
} from "../../resources/skill-provenance.ts";
import { refuseSkillWriteSource } from "../../resources/skill-write.ts";

const INSPECT_PATH = "/tmp/harperfast-skills-inspect/package/harper-best-practices/SKILL.md";
const NPM_SOURCE = "npm:@harperfast/skills@1.4.2@1.4.2";
// #1844 — the durable fixture must classify as durable regardless of BOTH where
// the checkout (cwd) lives AND what HOME resolves to. The test:unit lane
// (scripts/test-unit.ts) sandboxes HOME to a per-step mkdtemp dir under
// tmpdir() (flair#1853), so a HOME/homedir()-rooted fixture classifies as
// non-durable under the lane even though it is durable elsewhere — a false
// failure. The provenance classifier (isNonDurableFilesystemPath) marks a path
// non-durable only when it resolves under a temp root (tmpdir / /tmp /
// /private/tmp / /var/tmp / TMP* env). This absolute fixture lives at /, outside
// every temp root, so its classification is independent of cwd and HOME. The
// registration path is pure string parsing (no filesystem read), so the path need
// not exist on disk.
const DURABLE_FS = join("/flair-durable-skills", "harper-best-practices", "SKILL.md");

function meta(source: string): string {
  return JSON.stringify({ source });
}

function assignment(name: string, source: string | undefined, priority = "standard") {
  return {
    key: "skill-assignment",
    value: name,
    priority,
    metadata: source ? meta(source) : undefined,
  };
}

// #1844 — guard: assert the durable fixture classifies as durable, so a change
// to the classification rule fails here with a clear name (independent of cwd
// and the test:unit sandbox HOME) instead of surfacing as two unrelated
// failures in the tests that use DURABLE_FS below.
describe("fixture guard — DURABLE_FS classifies as durable (independent of cwd and sandboxed HOME)", () => {
  test("the durable fixture classifies as durable (#1844)", () => {
    expect(isDurableSkillSource(DURABLE_FS)).toBe(true);
   });
});

describe("defect 1 — refuse non-durable skill sources at registration", () => {
  test("known-answer: /tmp/harperfast-skills-inspect/... fails and names the path", async () => {
    const result = registerSkillAssignment(assignment("harper-best-practices", INSPECT_PATH));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toBe("skill_source_not_durable");
    expect(result.path).toBe(INSPECT_PATH);
    expect(result.message).toContain(INSPECT_PATH);

    const res = refuseSkillAssignmentWrite(assignment("harper-best-practices", INSPECT_PATH));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("skill_source_not_durable");
    expect(body.path).toBe(INSPECT_PATH);
    expect(body.message).toContain(INSPECT_PATH);
  });

  test("os.tmpdir() children, /var/tmp, file: URLs, and TMPDIR children fail and name the path", async () => {
    const cases = [
      join(tmpdir(), "scratch", "SKILL.md"),
      "/var/tmp/inspect/SKILL.md",
      `file://${INSPECT_PATH}`,
    ];
    for (const path of cases) {
      const result = registerSkillAssignment(assignment("scratch-skill", path));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected refusal for ${path}`);
      expect(result.path).toBe(path);
      expect(result.message).toContain(path);
    }
  });

  test("/tmpfoo is not treated as /tmp (separator-aware)", () => {
    expect(isDurableSkillSource("/tmpfoo/skills/SKILL.md")).toBe(true);
    expect(registerSkillAssignment(assignment("not-tmp", "/tmpfoo/skills/SKILL.md")).ok).toBe(true);
  });

  test("npm: specifiers and non-temp filesystem paths register", () => {
    expect(registerSkillAssignment(assignment("harperfast-skills", NPM_SOURCE)).ok).toBe(true);
    expect(registerSkillAssignment(assignment("local-skill", DURABLE_FS)).ok).toBe(true);
    expect(filesystemPathFromSkillSource(NPM_SOURCE)).toBeNull();
  });

  test("a skill-assignment with no source still registers (source is not required)", () => {
    expect(registerSkillAssignment(assignment("untitled", undefined)).ok).toBe(true);
  });

  test("non-assignment Soul keys are not gated", () => {
    const result = registerSkillAssignment({
      key: "identity",
      value: "I live in /tmp only as a metaphor",
      metadata: meta(INSPECT_PATH),
    });
    expect(result.ok).toBe(true);
    expect(refuseSkillAssignmentWrite({
      key: "identity",
      value: "x",
      metadata: meta(INSPECT_PATH),
    })).toBeNull();
  });

  test("skill-tagged Memory writes refuse a /tmp metadata.source and name it", async () => {
    const res = refuseSkillWriteSource({
      tags: ["skill"],
      trigger: "when inspecting harper skills",
      content: "a safe procedure",
      metadata: meta(INSPECT_PATH),
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("skill_source_not_durable");
    expect(body.path).toBe(INSPECT_PATH);
  });

  test("skill-tagged Memory writes with an npm: source still pass", () => {
    expect(refuseSkillWriteSource({
      tags: ["skill"],
      trigger: "when using harper skills",
      content: "a safe procedure",
      metadata: meta(NPM_SOURCE),
    })).toBeNull();
  });
});

describe("defect 2 — SKILL_CONFLICT determines a stated, deterministic outcome", () => {
  test("equal-priority same-name pair refuses both; payload states the tie; order-independent", () => {
    const a = assignment("runbook", "npm:@org/runbook@1.0.0", "standard");
    const b = assignment("runbook", "npm:@org/runbook@2.0.0", "standard");

    const forward = resolveActiveSkills([a, b]);
    const reverse = resolveActiveSkills([b, a]);

    expect(forward.outcomes.every((o) => o.decision === "refused" && !o.loaded)).toBe(true);
    expect(forward.outcomes).toHaveLength(2);
    for (const o of forward.outcomes) {
      expect(o.line).toContain("[SKILL_CONFLICT refused:");
      expect(o.line).toContain("equal-priority tie at standard");
      expect(o.reason).toContain("npm:@org/runbook@1.0.0");
      expect(o.reason).toContain("npm:@org/runbook@2.0.0");
    }
    // Restart / shuffle: same winner (none) and same stated reason.
    expect(forward.lines).toEqual(reverse.lines);
    expect(forward.outcomes.map((o) => o.reason)).toEqual(reverse.outcomes.map((o) => o.reason));
  });

  test("unique higher priority is stated precedence — winner loads, loser is superseded", () => {
    const low = assignment("runbook", "npm:@org/runbook@1.0.0", "standard");
    const high = assignment("runbook", "npm:@org/runbook@2.0.0", "high");

    const resolved = resolveActiveSkills([low, high]);
    const loaded = resolved.outcomes.filter((o) => o.loaded);
    const superseded = resolved.outcomes.filter((o) => o.decision === "superseded");

    expect(loaded).toHaveLength(1);
    expect(loaded[0].source).toBe("npm:@org/runbook@2.0.0");
    expect(loaded[0].line).not.toContain("SKILL_CONFLICT");
    expect(superseded).toHaveLength(1);
    expect(superseded[0].line).toContain("[SKILL_CONFLICT superseded:");
    expect(superseded[0].reason).toContain("high priority is stated precedence over standard");

    expect(resolveActiveSkills([high, low]).lines).toEqual(resolved.lines);
  });

  test("check 4: two different names at the same priority both load with no SKILL_CONFLICT (live #1433 false-positive shape)", () => {
    // Live evidence names from #1433 — different identities, both standard.
    // Main flags any same-priority peers; this must fail against that detector.
    const resolved = resolveActiveSkills([
      assignment("harper-best-practices", DURABLE_FS, "standard"),
      assignment("harperfast-skills", NPM_SOURCE, "standard"),
    ]);
    expect(resolved.outcomes).toHaveLength(2);
    const byName = Object.fromEntries(resolved.outcomes.map((o) => [o.name, o]));
    expect(byName["harper-best-practices"]?.loaded).toBe(true);
    expect(byName["harperfast-skills"]?.loaded).toBe(true);
    expect(byName["harper-best-practices"]?.line).not.toContain("SKILL_CONFLICT");
    expect(byName["harperfast-skills"]?.line).not.toContain("SKILL_CONFLICT");
    expect(byName["harper-best-practices"]?.decision).toBe("loaded");
    expect(byName["harperfast-skills"]?.decision).toBe("loaded");
  });

  test("a /tmp assignment already on disk is refused at load and does not shadow a durable peer of the same name", () => {
    const resolved = resolveActiveSkills([
      assignment("harper-best-practices", INSPECT_PATH),
      assignment("harper-best-practices", NPM_SOURCE),
    ]);
    const loaded = resolved.outcomes.filter((o) => o.loaded);
    const refused = resolved.outcomes.filter((o) => o.decision === "refused");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].source).toBe(NPM_SOURCE);
    expect(loaded[0].line).not.toContain("SKILL_CONFLICT");
    expect(refused).toHaveLength(1);
    expect(refused[0].line).toContain(INSPECT_PATH);
    expect(refused[0].line).toContain("non-durable source");
  });
});

describe("negative control — a normally-installed skill loads silently", () => {
  test("one durable non-conflicting assignment has no SKILL_CONFLICT and is loaded", () => {
    const resolved = resolveActiveSkills([assignment("harperfast-skills", NPM_SOURCE)]);
    expect(resolved.outcomes).toHaveLength(1);
    expect(resolved.outcomes[0].loaded).toBe(true);
    expect(resolved.outcomes[0].decision).toBe("loaded");
    expect(resolved.lines[0]).toBe(
      `- harperfast-skills (standard priority, source: ${NPM_SOURCE})`,
    );
    expect(resolved.lines[0]).not.toContain("SKILL_CONFLICT");
    expect(resolved.lines[0]).not.toContain("refused");
  });

  test("an assignment with no source still loads silently", () => {
    const resolved = resolveActiveSkills([assignment("house-style", undefined)]);
    expect(resolved.outcomes[0].loaded).toBe(true);
    expect(resolved.lines[0]).toBe("- house-style (standard priority)");
    expect(resolved.lines[0]).not.toContain("SKILL_CONFLICT");
  });
});

describe("wiring tripwires — main's inline report-and-load-both must be gone", () => {
  test("MemoryBootstrap delegates Active Skills to resolveActiveSkills", () => {
    const src = readFileSync("resources/MemoryBootstrap.ts", "utf8");
    expect(src).toContain("resolveActiveSkills");
    expect(src).not.toMatch(/if \(peers\.length > 1\)/);
    expect(src).not.toMatch(/line \+= " \[SKILL_CONFLICT\]"/);
  });

  test("Soul write path runs refuseSkillAssignmentWrite on post/put/patch", () => {
    const src = readFileSync("resources/Soul.ts", "utf8");
    expect(src).toContain("refuseSkillAssignmentWrite");
    expect(src.match(/refuseSkillAssignmentWrite/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("MemoryFeed runs refuseSkillWriteSource on the raw-table write (same gate as Memory.post)", () => {
    const src = readFileSync("resources/MemoryFeed.ts", "utf8");
    expect(src).toContain("refuseSkillWriteSource");
  });
});
