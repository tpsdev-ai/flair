// Server environment declared by a suite, and what happens to it in external
// mode. A local spawn merges the values (before secret stripping and the
// helper's own overrides); an `undefined` entry removes the variable instead.
// An external service cannot be given them, so startHarper refuses rather than
// silently running against a service configured some other way.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildHarperServerEnv, startHarper, stopHarper } from "../helpers/harper-lifecycle.js";
import { replicatedPairUnsupportedReason } from "../helpers/replicated-nodes.js";

const HELPER = pathToFileURL(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts")).href;
const REPLICATED_NODES = pathToFileURL(
  join(import.meta.dir, "..", "helpers", "replicated-nodes.ts"),
).href;
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "flair-2710-helper-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Run a script in a fresh process so the helper's module-level env read is the one under test. */
function runScript(
  name: string,
  source: string,
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, source);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`helper script ${name} exceeded 20s: ${stderr}`));
    }, 20_000);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

describe("buildHarperServerEnv", () => {
  test("declared serverEnv values override inherited values in the merge result", () => {
    const env = buildHarperServerEnv(
      { INHERITED: "kept", FLAIR_OAUTH_RATE_LIMIT: "30" },
      { env: { FROM_ENV: "yes" }, serverEnv: { FLAIR_OAUTH_RATE_LIMIT: "1000", FLAIR_TRUSTED_PROXY: "1" } },
    );
    expect(env.INHERITED).toBe("kept");
    expect(env.FROM_ENV).toBe("yes");
    expect(env.FLAIR_OAUTH_RATE_LIMIT).toBe("1000");
    expect(env.FLAIR_TRUSTED_PROXY).toBe("1");
  });

  test("an undefined serverEnv entry removes an inherited variable", () => {
    const env = buildHarperServerEnv(
      { KEEP: "kept", FLAIR_MCP_SIGNING_KEY_PEM: "ambient" },
      { serverEnv: { FLAIR_MCP_SIGNING_KEY_PEM: undefined } },
    );
    expect(env.KEEP).toBe("kept");
    expect(env).not.toHaveProperty("FLAIR_MCP_SIGNING_KEY_PEM");
  });

  test("an undefined serverEnv entry removes a value supplied through env", () => {
    const env = buildHarperServerEnv(
      {},
      { env: { FLAIR_MCP_SIGNING_KEY_PEM: "from-env" }, serverEnv: { FLAIR_MCP_SIGNING_KEY_PEM: undefined } },
    );
    expect(env).not.toHaveProperty("FLAIR_MCP_SIGNING_KEY_PEM");
  });
});

describe("startReplicatedPair", () => {
  // startReplicatedPair refuses before any spawn where a replicated pair cannot
  // start (replicatedPairUnsupportedReason: non-Linux hosts), so this case runs
  // only where it can reach the spawns.
  const pairUnsupported = replicatedPairUnsupportedReason();
  test.skipIf(pairUnsupported !== null)(`passes serverEnv to both node spawns${pairUnsupported ? ` [skipped: ${pairUnsupported}]` : ""}`, async () => {
    const { status, stdout, stderr } = await runScript(
      "pair",
      `import { mock } from "bun:test";
const calls = [];
mock.module(${JSON.stringify(HELPER)}, () => ({
  startHarper: async (opts) => {
    calls.push(opts);
    return { httpURL: "http://127.0.0.1:1", opsURL: "http://127.0.0.1:2", installDir: "", process: null,
      admin: { username: "admin", password: "x" }, external: false, ownsInstallDir: false };
  },
  stopHarper: async () => {},
}));
process.env.FLAIR_TEST_HARPER_PRO_DIR = "/nonexistent";
const { startReplicatedPair } = await import(${JSON.stringify(REPLICATED_NODES)});
const pair = await startReplicatedPair({
  serverEnv: { FLAIR_MCP_OAUTH: "true", FLAIR_MCP_SIGNING_KEY_PEM: undefined },
});
console.log("RESULT " + JSON.stringify(calls.map((c) => ({
  host: c.nodeHostname,
  oauth: c.serverEnv?.FLAIR_MCP_OAUTH,
  hasPin: Object.prototype.hasOwnProperty.call(c.serverEnv ?? {}, "FLAIR_MCP_SIGNING_KEY_PEM"),
  pin: c.serverEnv?.FLAIR_MCP_SIGNING_KEY_PEM ?? null,
}))));
await pair.stop();
`,
      {},
    );
    expect(status, stderr).toBe(0);
    const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
    expect(line).toBeDefined();
    const calls = JSON.parse(line!.slice("RESULT ".length)) as Array<{
      host: string;
      oauth: string;
      hasPin: boolean;
      pin: null;
    }>;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.oauth).toBe("true");
      expect(call.hasPin).toBe(true);
      expect(call.pin).toBeNull();
    }
    expect(calls[0]!.host).not.toBe(calls[1]!.host);
  }, 30_000);
});

// A real Harper proves the removal reaches the child, not just the merge
// result: the shipped config's mcp.enabled references FLAIR_MCP_OAUTH, so an
// ambient "true" that survived the spawn would degrade this boot (no issuer)
// and /mcp would answer 500; removed, the MCP route is absent.
describe("serverEnv removal in a spawned Harper", () => {
  test("a variable removed through an undefined entry is absent in the child", async () => {
    const prior = process.env.FLAIR_MCP_OAUTH;
    process.env.FLAIR_MCP_OAUTH = "true";
    const workDir = mkdtempSync(join(tmpdir(), "flair-2710-removed-"));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
    symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));
    cpSync(join(REPO_ROOT, "schemas"), join(workDir, "schemas"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "config.yaml"), join(workDir, "config.yaml"));
    let harper: Awaited<ReturnType<typeof startHarper>> | undefined;
    try {
      harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
        serverEnv: { FLAIR_MCP_OAUTH: undefined },
      });
      const res = await fetch(`${harper.httpURL}/mcp`, { signal: AbortSignal.timeout(10_000) });
      expect(res.status).toBe(404);
    } finally {
      if (prior === undefined) delete process.env.FLAIR_MCP_OAUTH;
      else process.env.FLAIR_MCP_OAUTH = prior;
      if (harper) await stopHarper(harper);
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("external mode", () => {
  test("a non-empty serverEnv refuses and names every variable and value", async () => {
    const { status, stderr } = await runScript(
      "refuse",
      `import { startHarper } from ${JSON.stringify(HELPER)};
try {
  await startHarper({ serverEnv: { FLAIR_OAUTH_RATE_LIMIT: "1000", FLAIR_TRUSTED_PROXY: "1" } });
  console.log("STARTED");
} catch (err) {
  console.error(err.message);
  process.exit(3);
}
`,
      { HARPER_HTTP_URL: "http://127.0.0.1:1" },
    );
    expect(status).toBe(3);
    expect(stderr).toContain("FLAIR_OAUTH_RATE_LIMIT=1000");
    expect(stderr).toContain("FLAIR_TRUSTED_PROXY=1");
    expect(stderr).toContain("HARPER_HTTP_URL");
  }, 15_000);

  test("an undefined entry refuses in external mode and is named", async () => {
    const { status, stderr } = await runScript(
      "refuse-undefined",
      `import { startHarper } from ${JSON.stringify(HELPER)};
try {
  await startHarper({ serverEnv: { FLAIR_MCP_SIGNING_KEY_PEM: undefined } });
  console.log("STARTED");
} catch (err) {
  console.error(err.message);
  process.exit(3);
}
`,
      { HARPER_HTTP_URL: "http://127.0.0.1:1" },
    );
    expect(status).toBe(3);
    expect(stderr).toContain("FLAIR_MCP_SIGNING_KEY_PEM");
    expect(stderr).toContain("HARPER_HTTP_URL");
  }, 15_000);

  test("without serverEnv it connects to the external service as before", async () => {
    const http = createServer((_req, res) => res.end("ok"));
    const ops = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => ops.listen(0, "127.0.0.1", resolve));
    const httpURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const opsURL = `http://127.0.0.1:${(ops.address() as AddressInfo).port}`;
    try {
      const { status, stdout, stderr } = await runScript(
        "external",
        `import { startHarper } from ${JSON.stringify(HELPER)};
const instance = await startHarper();
console.log("RESULT " + JSON.stringify({
  external: instance.external,
  hasProcess: instance.process !== null,
  httpURL: instance.httpURL,
  opsURL: instance.opsURL,
}));
`,
        { HARPER_HTTP_URL: httpURL, HARPER_OPS_URL: opsURL },
      );
      expect(status, stderr).toBe(0);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice("RESULT ".length))).toEqual({
        external: true,
        hasProcess: false,
        httpURL,
        opsURL,
      });
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await new Promise<void>((resolve) => ops.close(() => resolve()));
    }
  }, 20_000);
});
