/**
 * flair#2378 — `flair principal show` and `principal list` must report a
 * principal's `status` the way the auth path reads it.
 *
 * `isPrincipalDeactivated` treats an ABSENT `status` as active and any other
 * present value — including an explicit `null`, which the operations API
 * materialises for a cleared column — as deactivated. Both reporters used to
 * fold `null` into "active", so a principal the gate refuses displayed as
 * active.
 *
 * These cases drive the REAL built CLI against a stub HTTP server that returns
 * one row per shape, matching the existing `flair principal` stub tests. The
 * child HOME is a scratch dir; show targets the stub via FLAIR_URL and list via
 * --ops-port.
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

interface Row { id: string; name: string; kind: string; status?: unknown }

// One row per shape. `absent` omits the key entirely; `null` carries it as
// `null` — the shape the operations API materialises for a cleared column.
const ROWS: Row[] = [
  { id: "principal-absent", name: "principal-absent", kind: "agent" },
  { id: "principal-null", name: "principal-null", kind: "agent", status: null },
  { id: "principal-active", name: "principal-active", kind: "agent", status: "active" },
  { id: "principal-deactivated", name: "principal-deactivated", kind: "agent", status: "deactivated" },
];
const EXPECTED: Record<string, string> = {
  "principal-absent": "active",
  "principal-null": "deactivated",
  "principal-active": "active",
  "principal-deactivated": "deactivated",
};

function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, ...args], {
      cwd: env.HOME,
      env: {
        ...process.env,
        FLAIR_AGENT_ID: "", FLAIR_URL: "", FLAIR_OPS_PORT: "", FLAIR_TARGET: "", FLAIR_OPS_TARGET: "",
        FLAIR_OUTPUT: "human",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      // The child's OWN deadline: a numeric literal, so flair#1807's spawn-budget
      // gate reads it. CHILD_DEADLINE_MS below is the same value for the message.
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
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        const id = decodeURIComponent((req.url ?? "").replace(/^\/Agent\//, ""));
        res.writeHead(200);
        res.end(JSON.stringify(ROWS.find((r) => r.id === id) ?? null));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(ROWS));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
}

let stub: Awaited<ReturnType<typeof startStub>>;
let scratch: string;

/** The value in the `status` column of the `show` output. */
function shownStatus(stdout: string): string | undefined {
  return stdout.match(/^\s*status\s+(\S+)/m)?.[1];
}

/** The value in the `status` column of the row whose id is `id`, in `list`. */
function listedStatus(stdout: string, id: string): string | undefined {
  const line = stdout.split("\n").find((l) => l.trim().split(/\s+/)[0] === id);
  return line?.trim().split(/\s+/)[4];
}

describe("principal show/list report status the way auth reads it (#2378)", () => {
  beforeAll(async () => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-2378-home-"));
    stub = await startStub();
  }, 120_000);

  afterAll(async () => {
    stub.server.closeAllConnections();
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  });

  for (const id of Object.keys(EXPECTED)) {
    test(`show: ${id} displays ${EXPECTED[id]}`, async () => {
      const result = await runCli(["principal", "show", id], {
        HOME: scratch,
        FLAIR_URL: `http://127.0.0.1:${stub.port}`,
        FLAIR_ADMIN_PASS: "local-pass-2378",
      });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(shownStatus(result.stdout)).toBe(EXPECTED[id]);
    }, 25_000);
  }

  test("list: each row shape displays the status auth reads", async () => {
    const result = await runCli(["principal", "list", "--ops-port", String(stub.port), "--admin-pass", "local-pass-2378"], {
      HOME: scratch,
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    for (const [id, expected] of Object.entries(EXPECTED)) {
      expect(listedStatus(result.stdout, id)).toBe(expected);
    }
  }, 25_000);
});
