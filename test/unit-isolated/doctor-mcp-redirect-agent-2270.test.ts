import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const home = mkdtempSync(join(tmpdir(), "flair-2270-doctor-agent-"));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)) delete process.env[key];
}
process.env.HOME = home;
process.env.FLAIR_AGENT_ID = "ambient-agent";
mkdirSync(join(home, ".flair", "keys"), { recursive: true });
for (const agent of ["flag-agent", "ambient-agent"]) {
  writeFileSync(join(home, ".flair", "keys", `${agent}.key`), randomBytes(32), { mode: 0o600 });
}

const calls: unknown[][] = [];
let redirectPresent = false;
const doctor = await import("../../src/commands/doctor.ts");
const bindDoctor = doctor.bindCli;
mock.module("../../src/commands/doctor.ts", () => ({
  ...doctor,
  bindCli: (bindings: import("../../src/commands/doctor.ts").DoctorCli) => bindDoctor({
    ...bindings,
    api: (...args: unknown[]) => {
      calls.push(args);
      return args[1] === "/HealthDetail"
        ? { mcpOAuthProvider: { credentialsPresent: true, redirectPresent } }
        : [];
    },
    probeFlairReachable: async () => true,
    verifySemanticSearch: async () => ({ state: "skipped", reason: "fixture" }),
    checkAgentRegistered: async () => true,
  }),
}));
await import("../../src/cli.ts");

afterEach(() => mock.restore());
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(home, { recursive: true, force: true });
});

async function runDoctor(agent?: string): Promise<{ output: string; exit: number | undefined }> {
  calls.length = 0;
  const lines: string[] = [];
  let exit: number | undefined;
  spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({})) as unknown as typeof fetch);
  spyOn(process, "exit").mockImplementation(((code?: number) => {
    exit = code;
    throw new Error("fixture exit");
  }) as typeof process.exit);
  const program = new Command();
  doctor.register(program);
  try {
    await program.parseAsync(["node", "flair", "doctor", "--port", "9", ...(agent ? ["--agent", agent] : [])]);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "fixture exit") throw error;
  }
  return { output: lines.join("\n"), exit };
}

test("doctor passes the flag identity to the target redirect read", async () => {
  redirectPresent = true;
  const baseline = await runDoctor("flag-agent");
  mock.restore();
  redirectPresent = false;
  const missing = await runDoctor("flag-agent");
  const reads = calls.filter(call => call[1] === "/HealthDetail");
  expect(reads).toHaveLength(1);
  expect(reads[0]).toEqual(["GET", "/HealthDetail", undefined, {
    baseUrl: "http://127.0.0.1:9",
    keysDir: join(home, ".flair", "keys"),
    agentId: "flag-agent",
    agentIdSource: "flag",
  }]);
  expect(missing.output).toContain("OAUTH_GITHUB_REDIRECT_URI is missing");
  expect(missing.output).not.toContain("MCP OAuth redirect: cannot verify");
  const count = (output: string) => Number(/(\d+) issues? found/.exec(output)?.[1]);
  expect(count(missing.output)).toBe(count(baseline.output) + 1);
  expect(missing.exit).toBe(1);
}, 30_000);

test("doctor omits identity options without an agent flag", async () => {
  await runDoctor();
  const reads = calls.filter(call => call[1] === "/HealthDetail");
  expect(reads).toHaveLength(1);
  expect(reads[0]).toEqual(["GET", "/HealthDetail", undefined, {
    baseUrl: "http://127.0.0.1:9",
    keysDir: join(home, ".flair", "keys"),
  }]);
}, 30_000);
