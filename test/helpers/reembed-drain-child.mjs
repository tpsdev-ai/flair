import { Command } from "commander";
import { bindCli, register } from "../../dist/commands/reembed.js";
import { setInstancePairOsReadsForTests } from "../../dist/lib/local-instance-pair.js";

const agent = process.argv[2] === "agent";
const rows = Array.from({ length: 128 }, (_, i) => ({ id: `m-${String(i).padStart(3, "0")}`, agentId: "owner", content: "memory", embeddingModel: `${"x".repeat(32768)}END-${i}` }));
setInstancePairOsReadsForTests({
  listeners: () => ({ kind: "listeners", pids: [24600] }),
  birth: () => ({ kind: "birth", id: "24600@simulated" }),
  commandLine: () => "node\u0000/simulated/node_modules/harper/dist/bin/harper.js\u0000run\u0000.",
});
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === "/Health") return Response.json({ capabilities: ["memory-reembed-patch"] });
  if (url.pathname === "/Instance/") return Response.json([{ id: "instance" }]);
  if (init?.method === "PATCH") return Response.json({ id: decodeURIComponent(url.pathname.split("/").pop()) });
  const body = JSON.parse(init.body);
  if (body.operation === "get_configuration") return Response.json({ http: { port: 18726 }, operationsApi: { network: { port: 18725 } } });
  if (body.table === "Instance") return Response.json([{ id: "instance" }]);
  if (body.operation === "search_by_id") return Response.json(rows.filter(row => body.ids.includes(row.id)));
  if (body.operation === "search_by_conditions") return Response.json(rows);
  throw new Error(`unexpected ${url}`);
};
bindCli({
  privKeyPath: () => process.argv[3], resolveHttpPort: () => 18726, resolveOpsPort: () => 18725,
  resolveAgentHomeTarget: () => ({ httpPort: 18726, opsPort: 18725, pairBound: true }),
  ambiguousInstanceTargetError: "ambiguous_instance_target",
});
const program = new Command();
register(program);
await program.parseAsync(["reembed", ...(agent ? ["--agent", "owner"] : []), "--batch-size", "128", "--delay-ms", "0"], { from: "user" });
