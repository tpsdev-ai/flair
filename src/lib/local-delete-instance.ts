import { proveLocalInstancePair } from "./local-instance-pair.js";

export async function resolveLocalDeleteInstance(
  opts: { opsPort?: string | number; port?: string | number },
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number,
  authorization: string,
): Promise<{ opsUrl: string; baseUrl: string }> {
  const source = opts.opsPort !== undefined ? "--ops-port" : process.env.FLAIR_OPS_PORT ? "FLAIR_OPS_PORT" : "ops endpoint";
  const opsPort = resolveOpsPort(opts);
  const opsUrl = `http://127.0.0.1:${opsPort}/`;
  // The pair check is shared with `flair doctor` (local-instance-pair.ts).
  const pair = await proveLocalInstancePair(opsPort, authorization);
  if (pair.kind !== "proven") {
    const remedy = pair.remedy === undefined ? "" : ` ${pair.remedy}`;
    throw new Error(`${source} ${opsPort}: no matching local HTTP endpoint (${pair.detail}); refusing deletion.${remedy}`);
  }
  const httpPort = pair.httpPort;
  if (opts.port !== undefined && Number(opts.port) !== httpPort) {
    throw new Error(`--port ${opts.port} does not match ${source} ${opsPort}'s HTTP endpoint ${httpPort}; refusing deletion`);
  }
  return { opsUrl, baseUrl: `http://127.0.0.1:${httpPort}` };
}
