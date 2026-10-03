/**
 * flair#2127 — `flair principal disable|enable` must read the principal before
 * it writes. A missing id refuses by name with no update sent; an unreadable
 * read refuses as unverified; a success prints the status read back.
 *
 * Local path only: an explicit ephemeral `--ops-port` points at this file's
 * stub on 127.0.0.1, and the child HOME is a scratch dir, so no request can
 * reach a real instance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");

interface Observed { operation: string; body: any }
type Mode = "ok" | "missing" | "unreadable";

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, ...args], {
      cwd: env.HOME,
      env: { ...process.env, FLAIR_AGENT_ID: "", FLAIR_URL: "", FLAIR_OPS_PORT: "", FLAIR_TARGET: "", FLAIR_OPS_TARGET: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, { status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr })));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

async function startStub() {
  const seen: Observed[] = [];
  let mode: Mode = "ok";
  let readStatus = "deactivated";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ operation: body.operation, body });
      res.setHeader("Content-Type", "application/json");
      if (body.operation === "update") {
        // Harper answers an update for an id with no row; the guard must not
        // depend on this being false.
        res.writeHead(200);
        res.end(JSON.stringify({ update_hashes: [body.records[0].id], skipped_hashes: [] }));
        return;
      }
      if (mode === "missing") {
        res.writeHead(200);
        res.end("[]");
        return;
      }
      if (mode === "unreadable") {
        res.writeHead(200);
        res.end('{"error":"secret-response-token"}');
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify([{ id: body.search_value, status: readStatus }]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    seen,
    port,
    setMode: (m: Mode) => { mode = m; },
    setReadStatus: (s: string) => { readStatus = s; },
  };
}

let stub: Awaited<ReturnType<typeof startStub>>;
let scratch: string;
const args = (verb: "disable" | "enable", id: string) =>
  ["principal", verb, id, "--ops-port", String(stub.port), "--admin-pass", "local-pass-2127"];

describe("principal disable/enable read the principal first (#2127)", () => {
  beforeAll(async () => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-2127-home-"));
    stub = await startStub();
  });
  afterAll(async () => {
    stub.server.closeAllConnections();
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  });

  for (const [verb, id] of [["disable", "alice"], ["enable", "bob"]] as const) {
    test(`${verb}: a missing id refuses by name and sends no update`, async () => {
      stub.seen.length = 0;
      stub.setMode("missing");
      const result = await runCli(args(verb, id), { HOME: scratch });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`no principal ${id}`);
      expect(result.stdout).not.toContain("Principal");
      expect(stub.seen.map((x) => x.operation)).toEqual(["search_by_value"]);
    }, 25_000);
  }

  for (const [verb, id, status, word] of [
    ["disable", "alice", "deactivated", "deactivated"],
    ["enable", "bob", "active", "activated"],
  ] as const) {
    test(`${verb}: an existing principal prints the stored status read back`, async () => {
      stub.seen.length = 0;
      stub.setMode("ok");
      stub.setReadStatus(status);
      const result = await runCli(args(verb, id), { HOME: scratch });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Principal '${id}' ${word} (stored status: ${status})`);
      expect(stub.seen.map((x) => x.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
      expect(stub.seen[1].body.records[0]).toMatchObject({ id, status });
    }, 25_000);
  }

  test("a read-back that does not show the requested status refuses by name", async () => {
    stub.seen.length = 0;
    stub.setMode("ok");
    stub.setReadStatus("active");
    const result = await runCli(args("disable", "alice"), { HOME: scratch });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("did not confirm principal 'alice' is deactivated");
    expect(result.stderr).toContain("the read-back found active");
    expect(result.stdout).not.toContain("deactivated");
  }, 25_000);

  test("an unreadable read is refused as unverified — never as a missing principal — and sends no update", async () => {
    stub.seen.length = 0;
    stub.setMode("unreadable");
    const result = await runCli(args("disable", "alice"), { HOME: scratch });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("could not read principal alice");
    expect(result.stderr).not.toContain("no principal");
    expect(result.stderr).not.toContain("secret-response-token");
    expect(stub.seen.map((x) => x.operation)).toEqual(["search_by_value"]);
  }, 25_000);
});
