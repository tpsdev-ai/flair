/**
 * federation-sync-inherited-admin-pass-file-2889.test.ts — flair#2889
 *
 * `federation sync status` and `sync disable` inherit the admin-password pair
 * from `flair federation sync`, so commander stores the values on the parent
 * and the leaf's opts() is empty. These cases drive the built CLI against a
 * counting stub: an explicitly supplied bad file is refused before the action
 * runs, and a valid file's password is sent on `status`'s /FederationPeers
 * request instead of the ambient environment password.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCli } from "../helpers/build-cli-once.js";

const FILE_PASS = "file-secret-2889-sync-leaf";
const ENV_PASS = "env-secret-2889-sync-leaf";
const ADMIN_USER = "admin";

const homes: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterAll(() => {
  for (const server of servers) server.stop(true);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

interface Stub {
  port: number;
  requests: { method: string; path: string; auth: string }[];
}

function startStub(): Stub {
  const requests: Stub["requests"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization") ?? "",
      });
      if (url.pathname === "/FederationPeers") return Response.json({ peers: [] });
      return Response.json({});
    },
  });
  servers.push(server);
  return { port: Number(server.port), requests };
}

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  return home;
}

function passFile(mode: number): string {
  const home = tempHome("flair-2889-sync-pass-");
  const path = join(home, "admin-pass");
  writeFileSync(path, `${FILE_PASS}\n`, "utf-8");
  chmodSync(path, mode);
  return path;
}

function run(
  args: string[],
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key) && key !== "ROOTPATH"),
  );
  return new Promise((resolve, reject) => {
    const child = spawnCli(args, {
      env: { ...env, HOME: home, USERPROFILE: home, ...extraEnv },
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`CLI overran 20000 ms (${args.join(" ")})`));
      else resolve({ code, stdout, stderr });
    });
  });
}

describe("flair#2889 — federation sync status/disable apply the inherited admin password pair", () => {
  test("status refuses a 0644 file before sending a request, even with FLAIR_ADMIN_PASS set", async () => {
    const stub = startStub();
    const result = await run(
      ["federation", "sync", "status", "--target", `http://127.0.0.1:${stub.port}`, "--admin-pass-file", passFile(0o644)],
      tempHome("flair-2889-sync-home-"),
      { FLAIR_ADMIN_PASS: ENV_PASS },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("permissions 644 are too open");
    expect(stub.requests).toEqual([]);
  }, 60_000);

  test("status refuses a missing file before sending a request", async () => {
    const stub = startStub();
    const home = tempHome("flair-2889-sync-home-");
    const result = await run(
      ["federation", "sync", "status", "--target", `http://127.0.0.1:${stub.port}`, "--admin-pass-file", join(home, "absent-admin-pass")],
      home,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(join(home, "absent-admin-pass"));
    expect(stub.requests).toEqual([]);
  }, 60_000);

  test("status sends the valid file's password instead of FLAIR_ADMIN_PASS", async () => {
    const stub = startStub();
    const result = await run(
      ["federation", "sync", "status", "--target", `http://127.0.0.1:${stub.port}`, "--admin-pass-file", passFile(0o600)],
      tempHome("flair-2889-sync-home-"),
      { FLAIR_ADMIN_PASS: ENV_PASS },
    );
    if (result.code !== 0) throw new Error(`sync status failed:\n${result.stdout}\n${result.stderr}`);
    expect(result.code).toBe(0);
    expect(stub.requests.map((r) => r.path)).toEqual(["/FederationPeers"]);
    expect(stub.requests[0].auth).toBe(
      `Basic ${Buffer.from(`${ADMIN_USER}:${FILE_PASS}`).toString("base64")}`,
    );
  }, 60_000);

  test("disable refuses a 0644 file and leaves the installed unit in place", async () => {
    const home = tempHome("flair-2889-sync-home-");
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const timerPath = join(unitDir, "flair-federation-sync.timer");
    writeFileSync(timerPath, "fixture timer\n", "utf-8");

    const result = await run(
      ["federation", "sync", "disable", "--admin-pass-file", passFile(0o644)],
      home,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("permissions 644 are too open");
    expect(result.stdout).not.toContain("disabled");
    expect(readFileSync(timerPath, "utf-8")).toBe("fixture timer\n");
  }, 60_000);
});
