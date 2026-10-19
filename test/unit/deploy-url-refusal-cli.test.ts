/**
 * deploy-url-refusal-cli.test.ts — `flair deploy` and `flair upgrade --target`
 * check every URL they will use before they print anything: a deploy target,
 * operations API URL (--ops-target / FLAIR_OPS_TARGET) or MQTT check URL that
 * carries a user name, password, query or fragment, has a scheme other than
 * http or https (http, https, ws or wss for the check URL), or names no host
 * is refused, the command exits 1, and nothing it prints contains the refused
 * part. The refusal shows the URL only as scheme, host, port and path, and an
 * URL with another scheme or no host not at all (src/mqtt-off-deploy.ts
 * deployUrlRefusal / safeUrl). They also refuse `--require-all-nodes-verified`
 * combined with an option that skips the post-restart check, first thing.
 *
 * The CLI runs as a subprocess on the TS source, with a throwaway HOME and no
 * Fabric credentials in its environment; the refused URLs name hosts under
 * .invalid, so nothing could be reached even if a request were sent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { childOverranDeadline } from "../helpers/child-deadline.js";

const CLI_SOURCE = join(__dirname, "..", "..", "src", "cli.ts");
// The child's own deadline (20 s) and the case budget above it (60 s) are literals the spawn-budget gate reads.
const CHILD_DEADLINE_MS = 20_000;
const home = mkdtempSync(join(tmpdir(), "flair-deploy-url-refusal-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function runCLI(args: string[], env: Record<string, string> = {}): { exitCode: number | null; output: string; stdout: string; stderr: string } {
  const startedAt = Date.now();
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(FABRIC_|FLAIR_OPS_TARGET$)/.test(k)) clean[k] = v;
  }
  const r = spawnSync("bun", [CLI_SOURCE, ...args], {
    env: { ...clean, HOME: home, ...env },
    timeout: 20_000,
    encoding: "utf8",
  });
  if (r.status === null && r.signal) {
    throw new Error(childOverranDeadline("flair CLI", args.join(" "), CHILD_DEADLINE_MS, {
      status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM",
    }));
  }
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const SECRET = "not-a-real-secret-4711";

describe("flair deploy / flair upgrade --target refuse an unsafe URL before printing anything", () => {
  const cases: Array<[string, string[], Record<string, string>?]> = [
    ["deploy: a target with a user name and password", ["deploy", "--target", `https://deployer:${SECRET}@flair.example.invalid`, "--fabric-user", "u", "--fabric-password", "p"]],
    ["deploy: a target with a query", ["deploy", "--target", `https://flair.example.invalid/?token=${SECRET}`, "--fabric-user", "u", "--fabric-password", "p"]],
    ["deploy: an --ops-target with a fragment", ["deploy", "--target", "https://flair.example.invalid", "--ops-target", `https://flair.example.invalid:9925/#${SECRET}`, "--fabric-user", "u", "--fabric-password", "p"]],
    ["deploy: FLAIR_OPS_TARGET with a query", ["deploy", "--target", "https://flair.example.invalid", "--fabric-user", "u", "--fabric-password", "p"], { FLAIR_OPS_TARGET: `https://flair.example.invalid:9925/?key=${SECRET}` }],
    ["deploy: an --mqtt-check-url with a query", ["deploy", "--target", "https://flair.example.invalid", "--mqtt-check-url", `https://flair.example.invalid/?v=${SECRET}`, "--fabric-user", "u", "--fabric-password", "p"]],
    ["upgrade: a target with a user name and password", ["upgrade", "--target", `https://deployer:${SECRET}@flair.example.invalid`, "--yes"]],
    ["upgrade: a target with a query", ["upgrade", "--target", `https://flair.example.invalid/?value=${SECRET}`, "--yes"]],
    ["upgrade: an --ops-target with a query", ["upgrade", "--target", "https://flair.example.invalid", "--ops-target", `https://flair.example.invalid:9925/?q=${SECRET}`, "--yes"]],
    ["deploy: a file: target", ["deploy", "--target", `file:///tmp/${SECRET}`, "--fabric-user", "u", "--fabric-password", "p"]],
    ["deploy: a javascript: target", ["deploy", "--target", `javascript:${SECRET}`, "--fabric-user", "u", "--fabric-password", "p"]],
    ["deploy: a javascript: --ops-target", ["deploy", "--target", "https://flair.example.invalid", "--ops-target", `javascript:${SECRET}`, "--fabric-user", "u", "--fabric-password", "p"]],
    ["deploy: a ws: --ops-target", ["deploy", "--target", "https://flair.example.invalid", "--ops-target", "ws://flair.example.invalid:9925", "--fabric-user", "u", "--fabric-password", "p"]],
    ["deploy: a file: --mqtt-check-url", ["deploy", "--target", "https://flair.example.invalid", "--mqtt-check-url", `file:///tmp/${SECRET}`, "--fabric-user", "u", "--fabric-password", "p"]],
    ["deploy --verify-mqtt-only: a javascript: --ops-target", ["deploy", "--verify-mqtt-only", "--ops-target", `javascript:${SECRET}`, "--fabric-user", "u", "--fabric-password", "p"]],
    ["upgrade: a file: target", ["upgrade", "--target", `file:///tmp/${SECRET}`, "--yes"]],
    ["upgrade: a javascript: --mqtt-check-url", ["upgrade", "--target", "https://flair.example.invalid", "--mqtt-check-url", `javascript:${SECRET}`, "--yes"]],
  ];
  for (const [what, args, env] of cases) {
    test(what, () => {
      const r = runCLI(args, env);
      expect(r.exitCode, r.output).toBe(1);
      expect(r.output).not.toContain(SECRET);
      expect(r.output).not.toContain("deployer");
      expect(r.output).toContain("cannot be used");
      // The refusal is the first thing printed: nothing reaches stdout, and stderr opens with it.
      expect(r.stdout).toBe("");
      expect(r.stderr.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/^flair deploy: the .* cannot be used: (it carries a (user name or password|query|fragment)|its scheme is not (http or https|http, https, ws or wss)|it names no host)\. Nothing was sent\./);
    }, 60_000);
  }
});

describe("flair deploy / flair upgrade --target refuse --require-all-nodes-verified with an option that skips the post-restart check, first thing", () => {
  const cases: Array<[string, string[], string]> = [
    ["deploy --no-verify", ["deploy", "--target", "https://flair.example.invalid", "--require-all-nodes-verified", "--no-verify", "--fabric-user", "u", "--fabric-password", "p"], "--no-verify"],
    ["deploy --no-restart", ["deploy", "--target", "https://flair.example.invalid", "--require-all-nodes-verified", "--no-restart", "--fabric-user", "u", "--fabric-password", "p"], "--no-restart"],
    ["deploy --keep-mqtt-config", ["deploy", "--target", "https://flair.example.invalid", "--require-all-nodes-verified", "--keep-mqtt-config", "--fabric-user", "u", "--fabric-password", "p"], "--keep-mqtt-config"],
    ["deploy --verify-mqtt-only", ["deploy", "--target", "https://flair.example.invalid", "--require-all-nodes-verified", "--verify-mqtt-only", "--fabric-user", "u", "--fabric-password", "p"], "--verify-mqtt-only"],
    ["upgrade --target --no-restart", ["upgrade", "--target", "https://flair.example.invalid", "--require-all-nodes-verified", "--no-restart", "--yes"], "--no-restart"],
    ["upgrade --target --keep-mqtt-config", ["upgrade", "--target", "https://flair.example.invalid", "--require-all-nodes-verified", "--keep-mqtt-config", "--yes"], "--keep-mqtt-config"],
  ];
  for (const [what, args, flag] of cases) {
    test(what, () => {
      const r = runCLI(args);
      expect(r.exitCode, r.output).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(new RegExp(`^flair deploy: --require-all-nodes-verified cannot be combined with ${flag}: .*Nothing was deployed or sent\\.`));
    }, 60_000);
  }
});

describe("flair deploy --verify-mqtt-only refuses to run without what it needs, sending nothing", () => {
  test("without the admin credential", () => {
    const r = runCLI(["deploy", "--verify-mqtt-only", "--ops-target", "https://flair.example.invalid:9925"]);
    expect(r.exitCode, r.output).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("needs the admin credential");
  }, 60_000);
  test("without an operations API URL or a target", () => {
    const r = runCLI(["deploy", "--verify-mqtt-only", "--fabric-user", "u", "--fabric-password", "p"], { FLAIR_TARGET: "" });
    expect(r.exitCode, r.output).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("needs the node's operations API URL");
  }, 60_000);
});
