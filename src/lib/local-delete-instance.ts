import { proveLocalInstancePair } from "./local-instance-pair.js";

export async function resolveLocalDeleteInstance(
  opts: { opsPort?: string | number; port?: string | number },
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number,
  authorization: string,
): Promise<{ opsUrl: string; baseUrl: string }> {
  const source = opts.opsPort !== undefined ? "--ops-port" : process.env.FLAIR_OPS_PORT ? "FLAIR_OPS_PORT" : "ops endpoint";
  const opsPort = resolveOpsPort(opts);
  const opsUrl = `http://127.0.0.1:${opsPort}/`;
  // The pair check is shared with `flair doctor` (local-instance-pair.ts). It
  // runs before this command sends anything to the HTTP port.
  const pair = await proveLocalInstancePair(opsPort, authorization);
  if (pair.kind !== "proven") {
    throw new Error(
      `${source} ${opsPort}: the local HTTP/ops pair could not be proven (${pair.detail}); refusing deletion. ` +
        (pair.remedy ?? deleteRemedy(source, opsPort, pair.status)),
    );
  }
  const httpPort = pair.httpPort;
  if (opts.port !== undefined && Number(opts.port) !== httpPort) {
    throw new Error(
      `--port ${opts.port} does not match ${source} ${opsPort}'s HTTP endpoint ${httpPort}; refusing deletion. ` +
        `Pass --port ${httpPort}, or omit --port, or name the ops port of the instance that serves ${opts.port}.`,
    );
  }
  return { opsUrl, baseUrl: `http://127.0.0.1:${httpPort}` };
}

/** The remedy a delete refusal names when the pair check carries none. */
function deleteRemedy(source: string, opsPort: number, status: number | null): string {
  if (status === 401 || status === 403) {
    return `Check that the admin credential this command uses is the one for the instance on ${source} ${opsPort}.`;
  }
  return "Pass --ops-port with the ops port of the instance to delete from (or set FLAIR_OPS_PORT); if that instance's "
    + "configuration records ports it does not serve, correct it and restart the instance.";
}
