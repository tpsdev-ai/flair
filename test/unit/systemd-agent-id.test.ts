import { expect, test } from "bun:test";
import { systemdAgentId } from "../../src/lib/systemd-agent-id.ts";

test("only Environment assignments in Service supply an agent", () => {
  expect(systemdAgentId("# Environment=FLAIR_AGENT_ID=comment\n; Environment=FLAIR_AGENT_ID=comment\nDescription=FLAIR_AGENT_ID=description\n")).toBeNull();
  expect(systemdAgentId("[Unit]\nEnvironment=FLAIR_AGENT_ID=wrong\n[Service]\nEnvironment=FLAIR_AGENT_ID=right\n")).toBe("right");
});

test("last assignment wins across lines and within a line", () => {
  expect(systemdAgentId('Environment=FLAIR_AGENT_ID=old\nEnvironment="FLAIR_AGENT_ID=new"\n')).toBe("new");
  expect(systemdAgentId("Environment=OTHER=value FLAIR_AGENT_ID=old\t'FLAIR_AGENT_ID=new'\n")).toBe("new");
  expect(systemdAgentId("Environment=FLAIR_AGENT_ID=old\nEnvironment=\n")).toBeNull();
});

test("unsafe or unparseable assignments cannot match a valid prefix", () => {
  for (const value of ['"FLAIR_AGENT_ID=agent', "FLAIR_AGENT_ID=agent%I", "FLAIR_AGENT_ID=", "FLAIR_AGENT_ID=agent\\x", "FLAIR_AGENT_ID=agent\\"]) {
    expect(systemdAgentId(`Environment=FLAIR_AGENT_ID=old\nEnvironment=${value}\n`)).toBeNull();
  }
});
