import { harperPortValue } from "./harper-port-value.js";

export async function resolveLocalDeleteInstance(
  opts: { opsPort?: string | number; port?: string | number },
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number,
  authorization: string,
): Promise<{ opsUrl: string; baseUrl: string }> {
  const source = opts.opsPort !== undefined ? "--ops-port" : process.env.FLAIR_OPS_PORT ? "FLAIR_OPS_PORT" : "ops endpoint";
  const opsPort = resolveOpsPort(opts);
  const opsUrl = `http://127.0.0.1:${opsPort}/`;
  const refuse = () => new Error(`${source} ${opsPort}: no matching local HTTP endpoint; refusing deletion`);
  const response = await fetch(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify({ operation: "get_configuration" }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  }).catch(() => { throw refuse(); });
  if (!response.ok) throw refuse();
  const config = await response.json().catch(() => { throw refuse(); });
  const httpPort = harperPortValue(config?.http?.port);
  const configuredOpsPort = harperPortValue(config?.operationsApi?.network?.port);
  const binding = String(config?.http?.port ?? "");
  const separator = binding.lastIndexOf(":");
  const host = separator < 0 ? "127.0.0.1" : binding.slice(0, separator);
  if (httpPort === null || configuredOpsPort !== opsPort ||
    !["127.0.0.1", "localhost", "0.0.0.0", "[::]", ""].includes(host)) throw refuse();
  if (opts.port !== undefined && Number(opts.port) !== httpPort) {
    throw new Error(`--port ${opts.port} does not match ${source} ${opsPort}'s HTTP endpoint ${httpPort}; refusing deletion`);
  }
  return { opsUrl, baseUrl: `http://127.0.0.1:${httpPort}` };
}
