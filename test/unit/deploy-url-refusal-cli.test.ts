/**
 * deploy-url-refusal-cli.test.ts — `flair deploy` and `flair upgrade --target`
 * check every URL they will use before they print anything: a deploy target,
 * operations API URL (--ops-target / FLAIR_OPS_TARGET) or MQTT check URL that
 * carries a user name, password, query or fragment is refused, the command
 * exits 1, and nothing it prints contains the refused part. The refusal shows
 * the URL only as scheme, host, port and path (src/mqtt-off-deploy.ts
 * deployUrlRefusal / safeUrl).
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
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 60_000;
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
    timeout: CHILD_DEADLINE_MS,
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
      expect(r.stderr.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/^flair deploy: the .* cannot be used: it carries a (user name or password|query|fragment)\. Nothing was sent\./);
    }, CASE_BUDGET_MS);
  }
});
