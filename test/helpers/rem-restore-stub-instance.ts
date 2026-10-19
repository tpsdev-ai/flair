/**
 * rem-restore-stub-instance.ts — a stub Flair instance in its own process, for
 * `flair rem restore` target tests (flair#2708).
 *
 * One process serves an HTTP port and an operations port one below it (the
 * port-1 convention restore derives an operations port by). The script is
 * written to `<tmp>/node_modules/harper/dist/bin/harper.js` and run as
 * `bun <that path>`, so the OS listener table shows one process with a
 * Harper-shaped command line on both ports, as for a real instance; restore's
 * loopback pair check (src/lib/local-instance-pair.ts) reads exactly that.
 *
 * The operations port answers `get_configuration` with the process's own two
 * ports and `search_by_conditions` on MemoryCandidate from the seeded rows.
 * The HTTP port serves GET/PUT/DELETE on Memory, Soul and MemoryCandidate, or
 * answers every PUT and DELETE with a 307 when `redirectWritesTo` is seeded.
 * Every request is appended to a log file that `requests()` reads.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StubRequest {
  endpoint: "ops" | "http";
  method: string;
  path: string;
  operation?: string;
  table?: string;
}

export interface StubSeed {
  memories?: Array<Record<string, unknown>>;
  souls?: Array<Record<string, unknown>>;
  candidates?: Array<Record<string, unknown>>;
  /** When set, every PUT and DELETE on the HTTP port answers 307 to this base URL plus the request path. */
  redirectWritesTo?: string;
}

export interface StubInstance {
  httpPort: number;
  opsPort: number;
  httpUrl: string;
  opsUrl: string;
  pid: number;
  /** Every request this instance received, in order. */
  requests: () => StubRequest[];
  /** Stops the process by its pid and removes its directory. */
  stop: () => Promise<void>;
}

const STUB_SERVER_SOURCE = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
const [logPath, seedPath] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(seedPath, "utf-8"));
const tables = {
  Memory: new Map((seed.memories ?? []).map((r) => [r.id, r])),
  Soul: new Map((seed.souls ?? []).map((r) => [r.id, r])),
  MemoryCandidate: new Map((seed.candidates ?? []).map((r) => [r.id, r])),
};
const ports = { http: 0, ops: 0 };
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + "\n");

async function opsFetch(req) {
  let body;
  try { body = await req.json(); } catch { body = undefined; }
  log({ endpoint: "ops", method: req.method, path: new URL(req.url).pathname, operation: body?.operation, table: body?.table });
  if (body?.operation === "get_configuration") {
    return Response.json({ http: { port: ports.http }, operationsApi: { network: { port: ports.ops } } });
  }
  if (body?.operation === "search_by_conditions" && body.table === "MemoryCandidate") {
    const agent = (body.conditions ?? []).find((c) => c.search_attribute === "agentId")?.search_value;
    return Response.json([...tables.MemoryCandidate.values()].filter((c) => c.agentId === agent).map((c) => ({ id: c.id, claim: c.claim })));
  }
  return Response.json([]);
}

async function httpFetch(req) {
  const url = new URL(req.url);
  const body = req.method === "PUT" ? await req.json() : undefined;
  log({ endpoint: "http", method: req.method, path: url.pathname });
  if (seed.redirectWritesTo && (req.method === "PUT" || req.method === "DELETE")) {
    return new Response(null, { status: 307, headers: { location: seed.redirectWritesTo + url.pathname } });
  }
  const [table, rawId] = url.pathname.split("/").filter(Boolean);
  const rows = tables[table];
  const id = rawId ? decodeURIComponent(rawId) : "";
  if (!rows) return new Response("not found", { status: 404 });
  if (req.method === "GET" && !id) {
    const agent = url.searchParams.get("agentId");
    return Response.json([...rows.values()].filter((r) => !agent || r.agentId === agent));
  }
  if (req.method === "PUT" && id) { rows.set(id, body); return Response.json(body); }
  if (req.method === "DELETE" && id) { rows.delete(id); return new Response(null, { status: 204 }); }
  return new Response("not found", { status: 404 });
}

let started = null;
for (let attempt = 0; attempt < 50 && !started; attempt++) {
  let ops;
  try { ops = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: opsFetch }); } catch { continue; }
  if (ops.port + 1 > 65535) { ops.stop(true); continue; }
  try {
    const http = Bun.serve({ hostname: "127.0.0.1", port: ops.port + 1, fetch: httpFetch });
    started = { ops, http };
  } catch { ops.stop(true); }
}
if (!started) { console.error("no adjacent HTTP/operations port pair"); process.exit(1); }
ports.ops = started.ops.port;
ports.http = started.http.port;
console.log(JSON.stringify({ httpPort: ports.http, opsPort: ports.ops }));
`;

async function readFirstLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!text.includes("\n")) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("stub instance did not report its ports in time");
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stub instance did not report its ports in time")), remaining)),
      ]);
      if (chunk.done) throw new Error(`stub instance exited before reporting its ports: ${text}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text.slice(0, text.indexOf("\n"));
}

export async function startStubInstance(seed: StubSeed = {}): Promise<StubInstance> {
  const dir = mkdtempSync(join(tmpdir(), "flair-2708-stub-"));
  const binDir = join(dir, "node_modules", "harper", "dist", "bin");
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, "harper.js");
  const logPath = join(dir, "requests.jsonl");
  const seedPath = join(dir, "seed.json");
  writeFileSync(script, STUB_SERVER_SOURCE);
  writeFileSync(seedPath, JSON.stringify(seed));
  writeFileSync(logPath, "");

  const proc = Bun.spawn(["bun", script, logPath, seedPath], { stdout: "pipe", stderr: "pipe" });
  const stop = async (): Promise<void> => {
    try {
      if (proc.exitCode === null && proc.signalCode === null) {
        process.kill(proc.pid, "SIGTERM");
        const exited = await Promise.race([proc.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
        if (!exited) process.kill(proc.pid, "SIGKILL");
      }
    } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  };

  let ports: { httpPort: number; opsPort: number };
  try {
    ports = JSON.parse(await readFirstLine(proc.stdout, 15_000));
  } catch (err) {
    await stop();
    throw err;
  }
  return {
    ...ports,
    httpUrl: `http://127.0.0.1:${ports.httpPort}`,
    opsUrl: `http://127.0.0.1:${ports.opsPort}`,
    pid: proc.pid,
    requests: () => {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as StubRequest);
    },
    stop,
  };
}
