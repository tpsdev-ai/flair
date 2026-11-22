/**
 * admin-pass-file-wired-2889.test.ts — flair#2889
 *
 * Behavioural proof that the admin-password pair is applied by the option
 * helper before the action runs. Each command below drives the built CLI
 * against a counting stub: a 0644 file exits 1 with the permission text and no
 * request; a 0600 file sends the file's password as Basic auth. `principal
 * disable` and `principal enable` are the pair the review demonstrated could
 * drop the call unnoticed; `idp list` and `federation instance list` had no
 * wire test.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCli } from "../helpers/build-cli-once.js";

const PASS = "fixture-admin-pass-2889";
const ADMIN_USER = "admin";
const CASES = [
  { name: "principal disable", args: ["principal", "disable", "principal-a"] },
  { name: "principal enable", args: ["principal", "enable", "principal-a"] },
  { name: "idp list", args: ["idp", "list"] },
  { name: "federation instance list", args: ["federation", "instance", "list"] },
] as const;

const homes: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterAll(() => {
  for (const server of servers) server.stop(true);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

interface Stub {
  port: number;
  requests: { auth: string; body: any }[];
}

function startStub(): Stub {
  let principalStatus = "active";
  const requests: { auth: string; body: any }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json().catch(() => ({}));
      requests.push({ auth: req.headers.get("authorization") ?? "", body });
      if (body.operation === "update") {
        principalStatus = body.records?.[0]?.status ?? principalStatus;
        return Response.json({ update_hashes: [body.records[0].id] });
      }
      if (body.operation === "search_by_value" && body.table === "Agent") {
        return Response.json([{ id: body.search_value, status: principalStatus }]);
      }
      return Response.json([]);
    },
  });
  servers.push(server);
  return { port: Number(server.port), requests };
}

function run(args: string[], passFile: string, stub: Stub) {
  const home = mkdtempSync(join(tmpdir(), "flair-2889-wired-"));
  homes.push(home);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key) && key !== "ROOTPATH"),
  );
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawnCli([...args, "--ops-port", String(stub.port), "--admin-pass-file", passFile], {
      env: { ...env, HOME: home, USERPROFILE: home },
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

function passFile(mode: number): string {
  const home = mkdtempSync(join(tmpdir(), "flair-2889-pass-"));
  homes.push(home);
  const path = join(home, "admin-pass");
  writeFileSync(path, `${PASS}\n`, "utf-8");
  chmodSync(path, mode);
  return path;
}

describe("flair#2889 — the pair is applied before the action for the sampled wired commands", () => {
  for (const testCase of CASES) {
    test(`${testCase.name}: a 0644 file exits 1 with the permission text and sends nothing`, async () => {
      const stub = startStub();
      const result = await run([...testCase.args], passFile(0o644), stub);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("permissions 644 are too open");
      expect(result.stderr).toContain("chmod 600");
      expect(result.stdout).toBe("");
      expect(stub.requests).toEqual([]);
    }, 60_000);

    test(`${testCase.name}: a 0600 file sends its password as Basic auth`, async () => {
      const stub = startStub();
      const result = await run([...testCase.args], passFile(0o600), stub);
      if (result.code !== 0) throw new Error(`${testCase.name} failed:\n${result.stdout}\n${result.stderr}`);
      expect(result.code).toBe(0);
      expect(stub.requests.length).toBeGreaterThan(0);
      const expected = `Basic ${Buffer.from(`${ADMIN_USER}:${PASS}`).toString("base64")}`;
      for (const request of stub.requests) expect(request.auth).toBe(expected);
      expect(result.stdout).not.toContain(PASS);
      expect(result.stderr).not.toContain(PASS);
    }, 60_000);
  }
});
