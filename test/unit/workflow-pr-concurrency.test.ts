/**
 * workflow-pr-concurrency.test.ts — flair#2785.
 *
 * Shape tests for the top-level `concurrency` block of every workflow that runs
 * on `pull_request`: a pull request's superseded runs cancel by PR number, and
 * every other event groups by commit sha with cancelling off, so a push to main
 * never cancels another commit's run.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const REPO = join(import.meta.dir, "..", "..");
const WORKFLOWS = [
  "test.yml",
  "migration-ci-lanes.yml",
  "smoke.yml",
  "federation-compat.yml",
  "docker-test.yml",
  "socket.yml",
  "first-run-hostile.yml",
] as const;

const GROUP =
  "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}";
const CANCEL = "${{ github.event_name == 'pull_request' }}";

interface Workflow {
  name?: string;
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
}

function document(file: string): Record<string, unknown> {
  return yaml.load(
    readFileSync(join(REPO, ".github", "workflows", file), "utf8"),
  ) as Record<string, unknown>;
}

function workflow(file: string): Workflow {
  return document(file) as Workflow;
}

/** js-yaml reads the bare `on` key as boolean true (YAML 1.1). */
function triggers(file: string): Record<string, unknown> {
  const doc = document(file);
  return (doc.on ?? doc["true"]) as Record<string, unknown>;
}

/** Evaluate a `${{ ... }}` template against a stand-in github context. */
function evaluate(template: string, github: Record<string, unknown>): string {
  return template.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    const value = new Function("github", `return (${expression});`)(github) as unknown;
    return String(value);
  });
}

function name(file: string): string {
  const value = workflow(file).name;
  if (value === undefined) throw new Error(`${file} has no name`);
  return value;
}

describe("pull_request workflows cancel superseded runs by PR number", () => {
  for (const file of WORKFLOWS) {
    test(`${file} carries the concurrency block`, () => {
      const concurrency = workflow(file).concurrency;
      expect(concurrency, `${file} concurrency`).toBeDefined();
      expect(concurrency?.group).toBe(GROUP);
      expect(concurrency?.["cancel-in-progress"]).toBe(CANCEL);
    });

    test(`${file} groups a pull request by its number and cancels in progress`, () => {
      const concurrency = workflow(file).concurrency;
      if (concurrency?.group === undefined) throw new Error(`${file} has no concurrency group`);
      const github = {
        workflow: name(file),
        event_name: "pull_request",
        event: { pull_request: { number: 42 } },
        sha: "0123456789abcdef0123456789abcdef01234567",
      };
      expect(evaluate(concurrency.group, github)).toBe(`${name(file)}-42`);
      expect(evaluate(String(concurrency["cancel-in-progress"]), github)).toBe("true");
    });

    test(`${file} groups a non-PR run by commit sha and never cancels it`, () => {
      const concurrency = workflow(file).concurrency;
      if (concurrency?.group === undefined) throw new Error(`${file} has no concurrency group`);
      const sha = "0123456789abcdef0123456789abcdef01234567";
      const github = { workflow: name(file), event_name: "push", event: {}, sha };
      expect(evaluate(concurrency.group, github)).toBe(`${name(file)}-${sha}`);
      expect(evaluate(String(concurrency["cancel-in-progress"]), github)).toBe("false");
    });
  }

  test("every listed workflow runs on pull_request", () => {
    for (const file of WORKFLOWS) {
      expect(Object.keys(triggers(file)), `${file} triggers`).toContain("pull_request");
    }
  });
});

describe("release auto-tag still matches the CI workflow", () => {
  test("test.yml is named CI and release-auto-tag triggers on that name", () => {
    expect(name("test.yml")).toBe("CI");
    const workflowRun = triggers("release-auto-tag.yml").workflow_run as
      | { workflows?: string[] }
      | undefined;
    expect(workflowRun?.workflows).toContain("CI");
  });
});
