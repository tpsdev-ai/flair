/**
 * skill-assignment-preflight.test.ts — pins the CLI copy of the server's
 * skill-assignment write rule to resources/skill-provenance.ts (flair#2953).
 *
 * `flair restore --replace` must decide an archived Soul row exactly as the
 * server's `refuseSkillAssignmentWrite` will. src/ cannot import resources/
 * (those imports do not survive npm packaging), so the predicate is copied;
 * this test runs both copies over the same fixtures and compares the outcome.
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

const FIXTURES: Array<{ name: string; content: Row; existing?: Row }> = [
  { name: "not a skill assignment", content: { key: "identity", value: "v" } },
  { name: "skill without metadata", content: { key: "skill-assignment", value: "a-skill" } },
  { name: "skill with a bare name", content: { key: "skill-assignment", value: "a-skill", metadata: meta("a-skill") } },
  { name: "skill with an npm source", content: { key: "skill-assignment", value: "a-skill", metadata: meta("npm:@example/skills@1.0.0") } },
  { name: "skill with a durable path", content: { key: "skill-assignment", value: "a-skill", metadata: meta("/flair-durable-skills/a-skill/SKILL.md") } },
  { name: "skill with a temp path", content: { key: "skill-assignment", value: "a-skill", metadata: meta("/tmp/skills-inspect/a-skill/SKILL.md") } },
  { name: "skill with a relative source", content: { key: "skill-assignment", value: "a-skill", metadata: meta("./skills/a-skill") } },
  { name: "skill with an object metadata", content: { key: "skill-assignment", value: "a-skill", metadata: { source: "/tmp/obj-source/SKILL.md" } } },
  { name: "skill with optOut true", content: { key: "skill-assignment", value: "a-skill", metadata: meta("npm:a", { optOut: true }) } },
  { name: "skill with optOut false", content: { key: "skill-assignment", value: "a-skill", metadata: meta("npm:a", { optOut: false }) } },
  { name: "skill with a non-boolean optOut", content: { key: "skill-assignment", value: "a-skill", metadata: meta("npm:a", { optOut: "yes" }) } },
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

describe("the CLI skill-assignment predicate matches the server's", () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, async () => {
      const server = await outcome(serverRefuse(fixture.content, fixture.existing));
      const cli = await outcome(cliRefuse(fixture.content, fixture.existing));
      expect(cli).toEqual(server);
    });
  }

  test("the source classifier agrees on durable and non-durable paths", () => {
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
