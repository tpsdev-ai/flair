/**
 * cli-drift-guidance-1719.test.ts — the unreachable/port-drift guidance must
 * not blame a config that is already correct (flair#1719).
 *
 * The old path printed `Your config points at <resolved URL>` without ever
 * reading the config, then offered `edit ~/.flair/config.yaml to set port: N`
 * when the file already said `port: N` — a remedy a user can follow exactly and
 * change nothing. This pins the wording: when the config's port IS the running
 * daemon's port, the guidance names the command that reconciles the instance
 * record instead of the file.
 */
import { describe, test, expect } from "bun:test";
import { formatPortDriftGuidance } from "../../src/commands/status.ts";

describe("flair#1719 — drift guidance reads the config before naming it", () => {
  test("config already correct: no 'edit config' no-op, points at the reconciling command", () => {
    const lines = formatPortDriftGuidance({
      baseUrl: "http://127.0.0.1:19926", // stale resolved URL
      discoveredPort: 9926, // the daemon
      configuredPort: 9926, // what the config actually says
    }).join("\n");

    // The no-op remedy must not appear.
    expect(lines).not.toContain("edit ~/.flair/config.yaml to set port");
    // The config's real value is quoted, and a remedy that can change something
    // (reconcile the instance's own record) is offered.
    expect(lines).toContain("already records port 9926");
    expect(lines).toContain("flair doctor");
    // The stale resolved URL is named so the operator can see the divergence.
    expect(lines).toContain("http://127.0.0.1:19926");
  });

  test("config genuinely wrong: the edit is offered because it would change something", () => {
    const lines = formatPortDriftGuidance({
      baseUrl: "http://127.0.0.1:19926",
      discoveredPort: 9926,
      configuredPort: 9999,
    }).join("\n");

    expect(lines).toContain("records port 9999");
    expect(lines).toContain("set port: 9926");
  });

  test("no config port recorded: does not claim the config says anything", () => {
    const lines = formatPortDriftGuidance({
      baseUrl: "http://127.0.0.1:19926",
      discoveredPort: 9926,
      configuredPort: null,
    }).join("\n");

    expect(lines).toContain("No port is recorded");
    expect(lines).not.toContain("Your config points at");
  });
});
