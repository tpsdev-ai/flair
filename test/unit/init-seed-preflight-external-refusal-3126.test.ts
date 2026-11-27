// flair#3126 — test/integration/init-seed-preflight-3126.test.ts writes to the
// instance it targets, so it refuses an external instance (`HARPER_HTTP_URL`).
// This runs that suite in a child `bun test` with both URLs pointed at a
// recording server owned by this test. No Harper is started.
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SUITE = join(REPO_ROOT, "test", "integration", "init-seed-preflight-3126.test.ts");

test("init-seed-preflight-3126 with HARPER_HTTP_URL and HARPER_OPS_URL set refuses with no request to either URL", async () => {
  const requests: string[] = [];
  const recorder = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return new Response("unexpected request", { status: 500 });
    },
  });
  try {
    const url = `http://127.0.0.1:${recorder.port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$)/.test(key),
    ));
    const child = Bun.spawn([process.execPath, "test", SUITE], {
      cwd: REPO_ROOT,
      env: { ...env, HARPER_HTTP_URL: url, HARPER_OPS_URL: url },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = stdout + stderr;
    expect(requests).toEqual([]);
    expect(code, output).toBe(1);
    expect(output).toContain("requires an isolated Harper; unset HARPER_HTTP_URL");
  } finally {
    recorder.stop(true);
  }
}, 75_000);
