/**
 * rem-restore-target-2708.test.ts — `flair rem restore` lists candidates on
 * the same instance it writes to (flair#2708).
 *
 * Two stub instances on different ports: instance A is the default config's
 * instance, instance B is the FLAIR_URL target. The restore must send its
 * candidate listing and every write to B, or refuse before any write when the
 * listing target cannot be shown to be the write target.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSnapshot } from "../../src/rem/snapshot.ts";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
}

interface StubInstance {
  httpUrl: string;
  opsUrl: string;
  httpRequests: RecordedRequest[];
  opsRequests: RecordedRequest[];
  stop: () => void;
}

/**
 * Starts an HTTP/operations port pair one apart, which is the port-1
 * convention the restore target derivation uses. Ports are OS-assigned; the
 * pair is retried when the neighbour port is taken.
 */
function startStubInstance(): StubInstance {
  for (let attempt = 0; attempt < 50; attempt++) {
    const httpRequests: RecordedRequest[] = [];
    const opsRequests: RecordedRequest[] = [];
    const memories = new Map<string, unknown>();
    const souls = new Map<string, unknown>();

    const ops = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = req.method === "POST" ? await req.json() : undefined;
        opsRequests.push({ method: req.method, url: req.url, body });
        return Response.json([]);
      },
    });

    const opsPort = ops.port;
    if (opsPort === undefined) {
      ops.stop();
      continue;
    }
    const httpPort = opsPort + 1;
    if (httpPort > 65535) {
      ops.stop();
      continue;
    }

    let http: ReturnType<typeof Bun.serve>;
    try {
      http = Bun.serve({
        hostname: "127.0.0.1",
        port: httpPort,
        async fetch(req) {
          const url = new URL(req.url);
          const body = req.method === "PUT" ? await req.json() : undefined;
          httpRequests.push({ method: req.method, url: req.url, body });
          const parts = url.pathname.split("/").filter(Boolean);
          const id = parts.length > 1 ? decodeURIComponent(parts[1]) : "";
          if (req.method === "GET" && parts[0] === "Memory") {
            return Response.json([...memories.values()]);
          }
          if (req.method === "GET" && parts[0] === "Soul") {
            return Response.json([...souls.values()]);
          }
          if (req.method === "PUT" && parts[0] === "Memory") {
            memories.set(id, body);
            return Response.json(body);
          }
          if (req.method === "PUT" && parts[0] === "Soul") {
            souls.set(id, body);
            return Response.json(body);
          }
          if (req.method === "DELETE") {
            memories.delete(id);
            souls.delete(id);
            return new Response(null, { status: 204 });
          }
          return new Response("not found", { status: 404 });
        },
      });
    } catch {
      ops.stop();
      continue;
    }

    return {
      httpUrl: `http://127.0.0.1:${http.port}`,
      opsUrl: `http://127.0.0.1:${opsPort}`,
      httpRequests,
      opsRequests,
      stop: () => {
        http.stop(true);
        ops.stop(true);
      },
    };
  }
  throw new Error("could not start a stub HTTP/ops port pair");
}

const homes: string[] = [];
const instances: StubInstance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(instanceA: StubInstance): string {
  const home = mkdtempSync(join(tmpdir(), "flair-2708-home-"));
  homes.push(home);
  mkdirSync(join(home, ".flair"), { recursive: true });
  writeFileSync(
    join(home, ".flair", "config.yaml"),
    `port: ${new URL(instanceA.httpUrl).port}\nopsPort: ${new URL(instanceA.opsUrl).port}\n`,
  );
  return home;
}

async function snapshotFor(home: string, agentId: string): Promise<string> {
  const iso = new Date();
  await createSnapshot({
    agentId,
    flairVersion: "0.0.0-test",
    memories: [{ id: "m1", agentId, content: "restored memory" }],
    soul: { id: `soul-${agentId}`, agentId, instructions: "be helpful" },
    pendingCandidateCount: null,
    rootOverride: join(home, ".flair", "snapshots"),
    nowOverride: iso,
  });
  return iso.toISOString().slice(0, 10);
}

function runRestore(args: {
  home: string;
  date: string;
  agentId: string;
  flairUrl: string;
  opsPort?: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: args.home,
    FLAIR_URL: args.flairUrl,
    FLAIR_OPS_PORT: args.opsPort,
    FLAIR_TOKEN: undefined,
    FLAIR_ADMIN_PASS: undefined,
    FLAIR_AGENT_ID: undefined,
    NO_COLOR: "1",
  };
  const child = Bun.spawn(
    ["bun", cliPath, "rem", "restore", args.date, "--agent", args.agentId, "--apply", "--admin-pass", "test-admin-pass"],
    { env, timeout: 30_000, stdout: "pipe", stderr: "pipe" },
  );
  return (async () => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    return { code, stdout, stderr };
  })();
}

const writeMethods = new Set(["DELETE", "PUT", "POST", "PATCH"]);

describe("flair#2708 — rem restore target", () => {
  test("lists candidates and writes on the FLAIR_URL instance, never the config instance", async () => {
    const a = startStubInstance();
    const b = startStubInstance();
    instances.push(a, b);
    const agentId = "agent-a";
    const home = makeHome(a);
    const date = await snapshotFor(home, agentId);

    const result = await runRestore({ home, date, agentId, flairUrl: b.httpUrl });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Status:       completed");

    // The candidate listing is an ops-API POST, and it reached B.
    expect(b.opsRequests.some((r) => r.method === "POST")).toBe(true);
    const opsBody = b.opsRequests.find((r) => r.method === "POST")?.body as { operation?: string } | undefined;
    expect(opsBody?.operation).toBe("search_by_conditions");
    // The writes reached B as well.
    expect(b.httpRequests.some((r) => r.method === "PUT" && new URL(r.url).pathname.startsWith("/Soul/"))).toBe(true);
    expect(b.httpRequests.some((r) => r.method === "PUT" && new URL(r.url).pathname.startsWith("/Memory/"))).toBe(true);

    // Instance A, named by the default config, received nothing.
    expect(a.httpRequests).toEqual([]);
    expect(a.opsRequests).toEqual([]);

    // Every request addressed one of B's two ports.
    const bPorts = new Set([new URL(b.httpUrl).port, new URL(b.opsUrl).port]);
    const ports = [...b.httpRequests, ...b.opsRequests].map((r) => new URL(r.url).port);
    expect(ports.length).toBeGreaterThan(0);
    expect([...new Set(ports)]).toEqual([...bPorts]);
  }, 60_000);

  test("refuses before any write when FLAIR_OPS_PORT names another instance", async () => {
    const a = startStubInstance();
    const b = startStubInstance();
    instances.push(a, b);
    const agentId = "agent-a";
    const home = makeHome(a);
    const date = await snapshotFor(home, agentId);

    const result = await runRestore({
      home,
      date,
      agentId,
      flairUrl: b.httpUrl,
      opsPort: new URL(a.opsUrl).port,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("FLAIR_OPS_PORT");
    expect(result.stderr).toContain(b.httpUrl);

    const allRequests = [...a.httpRequests, ...a.opsRequests, ...b.httpRequests, ...b.opsRequests];
    const writes = allRequests.filter((r) => writeMethods.has(r.method));
    expect(writes).toEqual([]);
    // The listing itself did not run either: the target was refused first.
    expect(allRequests).toEqual([]);
  }, 60_000);
});
