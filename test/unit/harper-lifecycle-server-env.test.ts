// Server environment declared by a suite, and what happens to it in external
// mode. A local spawn merges the values (before secret stripping and the
// helper's own overrides); an external service cannot be given
// them, so startHarper refuses rather than silently running against a service
// configured some other way.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildHarperServerEnv } from "../helpers/harper-lifecycle.js";

const HELPER = pathToFileURL(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts")).href;
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
