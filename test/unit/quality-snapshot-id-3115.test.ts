// quality-snapshot-id-3115.test.ts — flair#3115.
//
// `flair quality --emit` stored its snapshot under
// `${agentId}-quality-snapshot-${Date.now()}` and PUT it as an upsert, so two
// emits by one agent in the same millisecond kept one row. With `Date.now()` frozen,
// two emits must PUT distinct ids, and each PUT path must name its own body id.
// Driven in-process through the `quality --emit` action, with the module's API
// seam bound to a recorder.

import { describe, it, expect } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/quality.ts";
import { encodeRecordId } from "../../src/lib/record-id-path.js";

describe("flair#3115: quality snapshot ids", () => {
  it("two --emit runs with Date.now() frozen to one millisecond PUT distinct snapshot ids, each path naming its body id", async () => {
    const puts: Array<{ path: string; body: any }> = [];
    const unused = (): never => { throw new Error("unexpected helper"); };
    bindCli({
      api: async (method: string, path: string, body?: any) => {
        if (method === "PUT") { puts.push({ path, body }); return {}; }
        return []; // sample + previous-snapshot listing: none, so no events are published
      },
      fetchHealthDetail: async () => ({ healthy: true, baseUrl: "http://127.0.0.1:19926", healthData: {} }),
      publishOrgEvent: unused,
      relativeTime: () => "now",
      resolveSigningAgentId: () => ({ agentId: "agent-a", source: "flag" }),
      __pkgVersion: "0.0.0-test",
    });

    const realNow = Date.now;
    const realLog = console.log;
    Date.now = () => 1_800_000_000_000;
    console.log = () => {};
    try {
      for (let i = 0; i < 2; i++) {
        const program = new Command().exitOverride();
        register(program);
        await program.parseAsync(["quality", "--emit", "--agent", "agent-a", "--json"], { from: "user" });
      }
    } finally {
      Date.now = realNow;
      console.log = realLog;
    }

    expect(puts.length).toBe(2);
    expect(puts[0].body.id).not.toBe(puts[1].body.id);
    for (const put of puts) {
      expect(String(put.body.id)).toStartWith("agent-a-quality-snapshot-");
      expect(put.path).toBe(`/Memory/${encodeRecordId(String(put.body.id))}`);
    }
  }, 30_000);
});
