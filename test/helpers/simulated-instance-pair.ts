/** The pair proof needs OS listener reads; inject a simulated Harper. */
export const SIMULATED_LISTENER_TABLE = {
  listeners: () => ({ kind: "listeners" as const, pids: [24_600] }),
  birth: () => ({ kind: "birth" as const, id: "24600@simulated" }),
  commandLine: () => "node\u0000/simulated/node_modules/harper/dist/bin/harper.js\u0000run\u0000.",
};
