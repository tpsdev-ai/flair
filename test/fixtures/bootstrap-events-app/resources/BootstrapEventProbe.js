// Test-only probe: runs the real bootstrap resource and counts the OrgEvent rows
// it materializes. The legacy arm removes the query pushdown, keeping the same
// downstream filtering/admission code as the treatment. Use only in a dedicated
// single-worker test instance, with sequential requests (search is patched).
import { Resource, databases, server } from "harper";
import { agentContext } from "@tpsdev-ai/flair/server";
const encoder = new TextEncoder();

export class BootstrapEventProbe extends Resource {
  allowCreate() { return true; }

  async post({ legacy = false, options = {} }) {
    const table = databases.flair.OrgEvent;
    const original = table.search;
    const queries = [];
    table.search = function (query) {
      const effective = legacy ? {} : query;
      const iterable = original.call(this, effective);
      const metrics = { query: effective ?? {}, rows: 0, bytes: 0 };
      queries.push(metrics);
      return (async function* () {
        for await (const row of iterable) {
          metrics.rows++;
          metrics.bytes += encoder.encode(JSON.stringify(row)).byteLength;
          yield row;
        }
      })();
    };
    const start = performance.now();
    let result;
    try {
      const Cls = server.resources.get("BootstrapMemories").Resource;
      const resource = new Cls(undefined, agentContext("event-reader"));
      result = await resource.post({ agentId: "event-reader", includeContext: false, ...options });
    } finally {
      table.search = original;
    }
    const elapsedMs = performance.now() - start;
    for (const metrics of queries) {
      metrics.plan = original.call(table, { ...metrics.query, explain: true });
    }
    return { result, queries, elapsedMs };
  }
}
