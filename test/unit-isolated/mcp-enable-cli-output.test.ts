/**
 * flair#2113 review — what `flair mcp enable` prints when it succeeds.
 *
 * Runs the real registered command (`program.parseAsync`), not a helper, and
 * reads what it prints. The success lines claim only what the run checked: the
 * OAuth metadata check passed (the /mcp route is not probed), and, when this
 * run confirmed a --cimd-allowed-hosts list (ensured it in config.yaml, writing
 * the list only if the file did not already hold that exact list, and read it
 * back), whether that list includes claude.ai. The case where the file
 * already holds the list pins that the note does not claim a write. With no
 * flag the command does not inspect allowedHosts, so it must not say
 * "claude.ai can now connect" whatever list the instance has.
 *
 * Isolated because it changes process-wide state for the length of each test:
 * the working directory (the command resolves ./config.yaml), HOME, global
 * fetch, process.exit and console. Every request must go to the fake instance
 * host; the target check sees this machine's real hostname and a real child
 * process started as `... run .` in the temp config's directory.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import yaml from "js-yaml";
import { program } from "../../src/cli.ts";
import { generateRsaSigningKeyPair } from "../../src/lib/mcp-enable.ts";

const REPO_CONFIG = join(import.meta.dir, "..", "..", "config.yaml");
const HOST = "flair.example.com";
const ISSUER = `https://${HOST}`;

interface RunResult {
  out: string;
  err: string;
  exit: string | null;
  foreign: string[];
  configAfter: string;
  configBefore: string;
  /** Did the run leave a signing key or a secrets staging file in the temp dir? */
  keyWritten: boolean;
  secretsWritten: boolean;
  secretSets: string[];
  secretReads: string[];
}

/** Run `flair mcp enable` in a temp dir holding `config` as ./config.yaml. */
async function runEnable(
  config: string,
  extraArgs: string[],
  targetRunsFromTempDir: boolean,
  options: { confirmed?: boolean; pushSecrets?: boolean } = {},
): Promise<RunResult> {
  const tmp = mkdtempSync(join(tmpdir(), "flair-2113-cli-"));
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, config);
  mkdirSync(join(tmp, "home"));
  // Started like flair starts Harper: `... run .` in the application directory.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "run", "."], { cwd: tmp, stdio: "ignore" });
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origFetch = globalThis.fetch;
  const origExit = process.exit;
  const origLog = console.log;
  const origError = console.error;
  const out: string[] = [];
  const err: string[] = [];
  const foreign: string[] = [];
  let exit: string | null = null;
  let bootPid = 1000;
  const credentials: any[] = [];
  const secretSets: string[] = [];
  const secretReads: string[] = [];
  const pushPublicKey = options.pushSecrets ? generateRsaSigningKeyPair().publicKey : undefined;
  try {
    // Give the child a moment to exist before the target check reads its cwd.
    await new Promise((r) => setTimeout(r, 150));
    process.chdir(tmp);
    process.env.HOME = join(tmp, "home");
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname !== HOST) {
        foreign.push(String(url));
        return new Response("refused by test", { status: 599 });
      }
      if (u.pathname === "/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify({
          issuer: ISSUER,
          token_endpoint: `${ISSUER}/oauth/mcp/token`,
          client_id_metadata_document_supported: true,
          token_endpoint_auth_methods_supported: ["none"],
        }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.operation === "get_secrets_public_key" && pushPublicKey) {
        return new Response(JSON.stringify({ public_key: pushPublicKey }), { status: 200 });
      }
      if (body.operation === "set_secret") {
        secretSets.push(body.name);
        return new Response("{}", { status: 200 });
      }
      if (body.operation === "search_by_value" && body.table === "hdb_secret") {
        secretReads.push(body.search_value);
        return new Response(JSON.stringify([{ name: body.search_value, processEnv: true }]), { status: 200 });
      }
      if (body.operation === "system_information" && (body.attributes ?? []).includes("system")) {
        return new Response(JSON.stringify({
          system: { hostname: targetRunsFromTempDir ? hostname() : "another-host" },
          harperdb_processes: { core: [{ pid: child.pid }] },
        }), { status: 200 });
      }
      if (body.operation === "system_information") {
        bootPid += 1; // a new pid on every call: the restart check sees the process change
        return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid: bootPid }] } }), { status: 200 });
      }
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      if (body.operation === "search_by_conditions") {
        return new Response(JSON.stringify(credentials), { status: 200 });
      }
      if (body.operation === "upsert") {
        for (const r of body.records ?? []) credentials.push(r);
        return new Response(JSON.stringify({ message: "upserted" }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    }) as typeof fetch;
    process.exit = ((code?: number) => {
      exit = `process.exit(${code ?? 0})`;
      throw new Error(exit);
    }) as typeof process.exit;
    console.log = (...a: any[]) => { out.push(a.map(String).join(" ")); };
    console.error = (...a: any[]) => { err.push(a.map(String).join(" ")); };
    try {
      await program.parseAsync([
        "node", "flair", "mcp", "enable",
        "--instance", ISSUER,
        "--idp-client-id", "client-id",
        "--idp-client-secret", "client-secret",
        "--idp-subject", "octocat",
        "--admin-pass", "pw",
        "--signing-key-file", join(tmp, "signing-key.pem"),
        "--secrets-path", join(tmp, "secrets.env"),
        ...(options.pushSecrets ? [] : ["--secrets-mechanism", "env-file"]),
        ...(options.confirmed === false ? [] : ["--confirm-secrets-applied"]),
        ...extraArgs,
      ]);
    } catch (e: any) {
      if (!String(e?.message ?? "").includes("process.exit")) throw e;
    }
    return {
      out: out.join("\n"),
      err: err.join("\n"),
      exit,
      foreign,
      configAfter: readFileSync(configPath, "utf-8"),
      configBefore: config,
      keyWritten: existsSync(join(tmp, "signing-key.pem")),
      secretsWritten: existsSync(join(tmp, "secrets.env")),
      secretSets,
      secretReads,
    };
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
    globalThis.fetch = origFetch;
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    process.chdir(origCwd);
    child.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
}

const SHIPPED = readFileSync(REPO_CONFIG, "utf-8");
/** The shipped config.yaml with an allowedHosts list that leaves claude.ai out. */
const WITHOUT_CLAUDE_AI = SHIPPED.replace("        - claude.ai\n        - claude.com\n", "        - flair.example.com\n");

function allowedHosts(text: string): unknown {
  return (yaml.load(text) as any)["@harperfast/oauth"].mcp.clientIdMetadataDocuments.allowedHosts;
}

describe("flair mcp enable — the printed success claims only what was checked", () => {
  test("no flag, and the instance's unchanged list leaves claude.ai out: prints the metadata-check line and no claude.ai claim", async () => {
    expect(allowedHosts(WITHOUT_CLAUDE_AI)).toEqual(["flair.example.com"]);
    const r = await runEnable(WITHOUT_CLAUDE_AI, [], true);
    expect(r.foreign).toEqual([]);
    expect(r.exit).toBeNull();
    expect(r.out).toContain("The OAuth metadata check passed.");
    expect(r.out).toContain("The /mcp route itself was not probed.");
    expect(r.out).toContain("connector identity: mapped sub 'octocat' (provider 'github') to Agent 'self'; see docs/access-control.md for how /mcp tool calls use it.");
    expect(r.out).not.toContain("every /mcp call reads and writes AS");
    expect(r.out).not.toContain("can now connect");
    expect(r.out).not.toContain("claude.ai is not in");
    expect(r.configAfter).toBe(r.configBefore);
  }, 20000);

  test("the flag writes a list without claude.ai: the printed success says a claude.ai client_id URL is refused", async () => {
    const r = await runEnable(SHIPPED, ["--cimd-allowed-hosts", "flair.example.com"], true);
    expect(r.foreign).toEqual([]);
    expect(r.exit).toBeNull();
    expect(allowedHosts(r.configAfter)).toEqual(["flair.example.com"]);
    expect(r.out).toContain("The OAuth metadata check passed.");
    expect(r.out).toContain("claude.ai is not in the mcp.clientIdMetadataDocuments.allowedHosts list this run ensured and read back");
    expect(r.out).not.toContain("can now connect");
  }, 20000);

  test("the flag names the list the file already holds, without claude.ai: the file is not rewritten, and the note says this run ensured and read back that list, not that it wrote it", async () => {
    expect(allowedHosts(WITHOUT_CLAUDE_AI)).toEqual(["flair.example.com"]);
    const r = await runEnable(WITHOUT_CLAUDE_AI, ["--cimd-allowed-hosts", "flair.example.com"], true);
    expect(r.foreign).toEqual([]);
    expect(r.exit).toBeNull();
    expect(r.configAfter).toBe(r.configBefore);
    expect(r.out).toContain("the file already held this list, so the allowed-hosts write was skipped");
    // The cimd-allowed-hosts step's own sentence, which the config-block step points to.
    expect(r.out).toMatch(/writes it unless the file already holds that exact list\W+then reads it back\W+a run that stops before that step does not write it/);
    expect(r.out).toContain("The OAuth metadata check passed.");
    expect(r.out).toContain(
      'claude.ai is not in the mcp.clientIdMetadataDocuments.allowedHosts list this run ensured and read back (["flair.example.com"])',
    );
    expect(r.out).not.toContain("this run wrote");
  }, 20000);

  test("the flag writes a list with claude.ai: no claude.ai note", async () => {
    const r = await runEnable(SHIPPED, ["--cimd-allowed-hosts", "claude.ai,flair.example.com"], true);
    expect(r.exit).toBeNull();
    expect(allowedHosts(r.configAfter)).toEqual(["claude.ai", "flair.example.com"]);
    expect(r.out).toContain("The OAuth metadata check passed.");
    expect(r.out).not.toContain("claude.ai is not in");
  }, 20000);

  test("--dry-run, with and without the flag: writes no signing key, staged secrets or config change, and says where a key would be generated", async () => {
    for (const flag of [[], ["--cimd-allowed-hosts", "flair.example.com"]]) {
      const r = await runEnable(SHIPPED, ["--dry-run", ...flag], true);
      expect(r.foreign).toEqual([]);
      expect(r.exit).toBeNull();
      expect(r.out).toContain("a run without --dry-run generates one there (0600). --dry-run did not create it");
      expect(r.out).toContain("dry-run: no remote calls were made.");
      expect(r.keyWritten).toBe(false);
      expect(r.secretsWritten).toBe(false);
      expect(r.configAfter).toBe(r.configBefore);
    }
  }, 20000);

  test("the target runs on another host: the command exits 1, prints the refusal, and writes no signing key, staged secrets or config change", async () => {
    const r = await runEnable(SHIPPED, ["--cimd-allowed-hosts", "flair.example.com"], false);
    expect(r.foreign).toEqual([]);
    expect(r.exit).toBe("process.exit(1)");
    expect(r.out).toContain("--cimd-allowed-hosts refused");
    expect(r.out).toContain("another-host");
    expect(r.out).not.toContain("The OAuth metadata check passed.");
    expect(r.configAfter).toBe(r.configBefore);
    expect(r.keyWritten).toBe(false);
    expect(r.secretsWritten).toBe(false);
  }, 20000);

  test("a verified push without confirmation prints the load instruction, not the staged-file remedy", async () => {
    const r = await runEnable(SHIPPED, [], true, { confirmed: false, pushSecrets: true });
    expect(r.exit).toBe("process.exit(1)");
    expect(r.secretSets.length).toBeGreaterThan(0);
    expect(r.secretReads).toEqual(r.secretSets);
    expect(r.out).toContain(`the secrets were pushed to ${ISSUER} and read back; load them into the instance's process environment`);
    expect(r.out).not.toContain("apply the staged secrets");
    expect(r.out).not.toContain("once the staged secrets are live");
  }, 20000);

  test("without a push, the unconfirmed CLI still prints the staged-file remedy", async () => {
    const r = await runEnable(SHIPPED, [], true, { confirmed: false });
    expect(r.exit).toBe("process.exit(1)");
    expect(r.secretSets).toEqual([]);
    expect(r.out).toContain(`not applied: pass --confirm-secrets-applied once the staged secrets are live on ${ISSUER}`);
  }, 20000);
});
