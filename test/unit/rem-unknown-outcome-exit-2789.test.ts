/**
 * rem-unknown-outcome-exit-2789.test.ts — `flair rem light`, `rem rapid` and
 * `rem restorative` report a write's unknown outcome and exit 3 (flair#2789).
 *
 * light and restorative run as the built CLI against a local HTTP listener;
 * the request that expires is POST /ConsolidateMemories, which uses
 * FLAIR_REQUEST_TIMEOUT_MS. rapid's only request is POST /ReflectMemories, which
 * carries the explicit 900 s deadline, so its action is driven from the built
 * dist module with an injected api that throws the same error the deadline
 * raises. That is the command action and its catch, not a unit of the catch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const AGENT_ID = "agent-a";
const DEADLINE_MS = 100;

function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("FLAIR_") && !key.startsWith("HDB_")) childEnv[key] = value;
    }
    Object.assign(childEnv, env);
    const child = spawn(nodeBin({ env: childEnv, cwd: env.HOME }), [CLI_PATH, ...args], {
      cwd: env.HOME,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CHILD_DEADLINE_MS,
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

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startListener() {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const line = `${req.method} ${req.url ?? "/"}`;
      seen.push(line);
      if (req.method === "POST" && req.url === "/MemoryMaintenance") {
        return sendJson(res, { stats: { expired: 0, archived: 0, total: 0, errors: 0 } });
      }
      if (req.method === "POST" && req.url === "/ConsolidateMemories") {
        return; // accept, never answer: the client's deadline decides
      }
      return sendJson(res, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    seen,
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let listener: Awaited<ReturnType<typeof startListener>>;
let home: string;

beforeAll(async () => {
  ensureCliBuild();
  home = mkdtempSync(join(tmpdir(), "flair-2789-rem-exit-"));
  listener = await startListener();
}, 120_000);

afterAll(async () => {
  if (listener) await listener.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2789 — rem commands exit 3 for an unknown write outcome", () => {
  for (const [command, maintenanceRuns] of [["light", 1], ["restorative", 1]] as const) {
    test(`rem ${command} prints the unknown outcome and exits 3`, async () => {
      listener.seen.length = 0;
      const result = await runCli(
        ["rem", command, "--agent", AGENT_ID],
        { HOME: home, FLAIR_URL: `http://127.0.0.1:${listener.port}`, FLAIR_REQUEST_TIMEOUT_MS: String(DEADLINE_MS), NO_COLOR: "1" },
      );
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(result.code, detail).toBe(3);
      expect(result.stderr, detail).toContain("Unknown outcome:");
      expect(result.stderr, detail).toContain("may or may not have taken effect");
      expect(listener.seen.filter((l) => l === "POST /MemoryMaintenance"), detail).toHaveLength(maintenanceRuns);
      expect(listener.seen.filter((l) => l === "POST /ConsolidateMemories"), detail).toHaveLength(1);
    }, 30_000);
  }

  class ExitCalled extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }

  async function runRapid(args: string[]): Promise<{ code: number | undefined; output: string[] }> {
    const remModule: any = await import(new URL("../../dist/commands/rem.js", import.meta.url).href);
    const distAuth: any = await import(new URL("../../dist/lib/auth-resolve.js", import.meta.url).href);
    remModule.bindCli({
      api: async (method: string, path: string) => {
        throw new distAuth.ApiRequestOutcomeUnknown(method, path, 900_000, undefined, "explicit");
      },
      DEFAULT_PORT: 19926,
      pkgVersion: "0.0.0-test",
      addSharedCredentialOptions: (cmd: unknown) => cmd,
    } as any);
    const program = new Command();
    remModule.register(program);
    const output: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    const realExit = process.exit;
    let code: number | undefined;
    console.log = (...a: unknown[]) => output.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => output.push(a.map(String).join(" "));
    (process as any).exit = (c?: number) => {
      code = c ?? 0;
      throw new ExitCalled(code);
    };
    try {
      await program.parseAsync(["node", "flair", "rem", "rapid", "--agent", AGENT_ID, ...args]);
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err;
    } finally {
      console.log = realLog;
      console.error = realError;
      (process as any).exit = realExit;
    }
    return { code, output };
  }

  test("rem rapid --prompt-only prints the unknown outcome and exits 3", async () => {
    const result = await runRapid(["--prompt-only"]);
    const detail = result.output.join("\n");
    expect(result.code, detail).toBe(3);
    expect(detail).toContain("Unknown outcome:");
    expect(detail).toContain("may or may not have taken effect");
  }, 20_000);

  test("rem rapid execute prints the unknown outcome and exits 3", async () => {
    const result = await runRapid([]);
    const detail = result.output.join("\n");
    expect(result.code, detail).toBe(3);
    expect(detail).toContain("Unknown outcome:");
    expect(detail).toContain("may or may not have taken effect");
  }, 20_000);
});
