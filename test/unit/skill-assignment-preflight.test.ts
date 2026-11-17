/**
 * skill-assignment-preflight.test.ts — pins the CLI copy of the server's
 * skill-assignment write rule to resources/skill-provenance.ts for sources
 * whose verdict does not depend on the process environment (flair#2953).
 *
 * src/ cannot import resources/ (those imports do not survive npm packaging),
 * so the predicate is copied; this test runs both copies in one process over
 * the same fixtures and compares the outcome. A filesystem-path source is not
 * environment-independent: non-dry-run replace refuses every such row
 * before any delete instead of deciding it (src/commands/restore.ts).
 */
import { describe, expect, test } from "bun:test";
import {
  filesystemPathFromSkillSource as serverFilesystemPath,
  isDurableSkillSource as serverIsDurable,
  refuseSkillAssignmentWrite as serverRefuse,
} from "../../resources/skill-provenance.ts";
import {
  filesystemPathFromSkillSource as cliFilesystemPath,
  isDurableSkillSource as cliIsDurable,
  refuseSkillAssignmentWrite as cliRefuse,
} from "../../src/lib/skill-assignment-preflight.ts";

type Row = Record<string, unknown>;

function meta(source: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ source, ...extra });
}

/** Fixtures whose verdict does not depend on tmpdir/TMPDIR/TMP/TEMP or cwd. */
const FIXTURES: Array<{ name: string; content: Row; existing?: Row }> = [
  { name: "not a skill assignment", content: { key: "identity", value: "v" } },
  { name: "skill without metadata", content: { key: "skill-assignment", value: "a-skill" } },
  { name: "skill with a bare name", content: { key: "skill-assignment", value: "a-skill", metadata: meta("a-skill") } },
  { name: "skill with an npm source", content: { key: "skill-assignment", value: "a-skill", metadata: meta("npm:@example/skills@1.0.0") } },
  { name: "skill with an object metadata", content: { key: "skill-assignment", value: "a-skill", metadata: { source: "npm:a" } } },
  { name: "skill with optOut true", content: { key: "skill-assignment", value: "a-skill", metadata: meta("npm:a", { optOut: true }) } },
  { name: "skill with optOut false", content: { key: "skill-assignment", value: "a-skill", metadata: meta("npm:a", { optOut: false }) } },
  { name: "skill with a non-boolean optOut", content: { key: "skill-assignment", value: "a-skill", metadata: meta("npm:a", { optOut: "yes" }) } },
  {
    name: "skill with the key and metadata supplied by existing",
    content: { value: "a-skill" },
    existing: { key: "skill-assignment", metadata: meta("npm:a") },
  },
  {
    name: "skill with content metadata overriding existing",
    content: { key: "skill-assignment", value: "a-skill", metadata: { source: "npm:a" } },
    existing: { key: "skill-assignment", metadata: meta("npm:b") },
  },
];

/** Filesystem-path rows: the two copies share this process's environment here. */
const FILESYSTEM_FIXTURES: Array<{ name: string; content: Row; existing?: Row }> = [
  { name: "skill with a durable path", content: { key: "skill-assignment", value: "a-skill", metadata: meta("/flair-durable-skills/a-skill/SKILL.md") } },
  { name: "skill with a temp path", content: { key: "skill-assignment", value: "a-skill", metadata: meta("/tmp/skills-inspect/a-skill/SKILL.md") } },
  { name: "skill with a relative source", content: { key: "skill-assignment", value: "a-skill", metadata: meta("./skills/a-skill") } },
  {
    name: "skill with the key and metadata supplied by existing",
    content: { value: "a-skill" },
    existing: { key: "skill-assignment", metadata: meta("/tmp/existing-source/SKILL.md") },
  },
  {
    name: "skill with content metadata overriding existing",
    content: { key: "skill-assignment", value: "a-skill", metadata: { source: "/flair-durable-skills/a/SKILL.md" } },
    existing: { key: "skill-assignment", metadata: meta("/tmp/existing-source/SKILL.md") },
  },
];

async function outcome(response: Response | null): Promise<unknown> {
  if (response === null) return null;
  return { status: response.status, body: await response.json() };
}

describe("same-process fixture parity for environment-independent inputs", () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, async () => {
      const server = await outcome(serverRefuse(fixture.content, fixture.existing));
      const cli = await outcome(cliRefuse(fixture.content, fixture.existing));
      expect(cli).toEqual(server);
    });
  }
});

describe("same-process agreement on filesystem fixtures (not a cross-process guarantee)", () => {
  for (const fixture of FILESYSTEM_FIXTURES) {
    test(fixture.name, async () => {
      const server = await outcome(serverRefuse(fixture.content, fixture.existing));
      const cli = await outcome(cliRefuse(fixture.content, fixture.existing));
      expect(cli).toEqual(server);
    });
  }

  test("the source classifier agrees in this process on paths and non-paths", () => {
    for (const source of [
      "a-skill",
      "npm:@example/skills@1.0.0",
      "https://example.test/skill",
      "/flair-durable-skills/a-skill/SKILL.md",
      "/tmp/skills-inspect/a-skill/SKILL.md",
      "/var/tmp/a-skill",
      "./skills/a-skill",
      "file:///flair-durable-skills/a/SKILL.md",
    ]) {
      expect(cliIsDurable(source)).toBe(serverIsDurable(source));
      expect(cliFilesystemPath(source)).toBe(serverFilesystemPath(source));
    }
  });
});
