/**
 * flair#2113 — `flair mcp enable --cimd-allowed-hosts` ensures the list the
 * @harperfast/oauth component reads in the edited config.yaml, and reads it
 * back, only after a preflight match with the target. Without --dry-run, a
 * failed match is refused. --dry-run skips the match and writes nothing; a
 * Fabric origin, an invalid host list and a missing or unusable config.yaml
 * are still refused under --dry-run.
 *
 * Before this fix the flag was parsed and echoed into a step line, and nothing
 * wrote it anywhere the @harperfast/oauth component reads.
 *
 * The list is read back the way the component computes it, not by trusting
 * the function that wrote the file: `componentAllowedHosts()` parses the
 * config.yaml with the same `yaml` library Harper's OptionsWatcher parses a
 * component config.yaml with, takes the `@harperfast/oauth` block (what
 * `scope.options.getAll()` hands the plugin), and runs the installed
 * @harperfast/oauth's own `expandEnvVarsDeep` + `normalizeMcpSecurityConfig`
 * over `mcp`, as its `updateConfiguration` does.
 *
 * Shapes: a non-Fabric target that passes the match gets the list ensured in
 * the edited config.yaml before the restart, and read back here. The
 * writer skips the write when the file already holds that exact list; that
 * case is covered in test/unit-isolated/mcp-enable-cli-output.test.ts, not
 * here. A Fabric origin, or (without --dry-run) a failed match, is refused
 * before any change. The target check's process and hostname lookups are
 * injected here, except in the
 * one test that uses a real child process. House style follows
 * mcp-enable.test.ts: injected fetch, temp dirs, the repo's own config.yaml is
 * copied and never written.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  expandEnvVarsDeep,
  normalizeMcpSecurityConfig,
} from "../../node_modules/@harperfast/oauth/dist/lib/config.js";
import {
  CimdAllowedHostsError,
  DEFAULT_CIMD_ALLOWED_HOSTS,
  cimdAllowedHostsFromFlag,
  checkTargetRunsFromConfig,
  cimdAllowedHostsShapeRefusal,
  harperAppDirFromCmdline,
  claudeAiExcludedNote,
  enableMcp,
  updateLocalConfigCimdAllowedHosts,
  validateCimdAllowedHosts,
} from "../../src/lib/mcp-enable.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const REPO_CONFIG = join(REPO_ROOT, "config.yaml");
// Harper's own YAML parser (its OptionsWatcher parses component config.yaml
// with this package), resolved from harper's real install directory rather
// than assumed hoisted (bun links node_modules/harper to its store).
const harperYaml = createRequire(realpathSync(join(REPO_ROOT, "node_modules", "harper", "package.json")))("yaml");

const ISSUER = "https://flair.example.com";
const FABRIC_ISSUER = "https://my-flair.harperfabric.com";

/** The allowedHosts the @harperfast/oauth component computes from `configPath`. */
function componentAllowedHosts(configPath: string): unknown {
  const root = harperYaml.parse(readFileSync(configPath, "utf-8"));
  const mcp = expandEnvVarsDeep(root["@harperfast/oauth"].mcp);
  normalizeMcpSecurityConfig(mcp, { warn() {} });
  return mcp.clientIdMetadataDocuments?.allowedHosts;
}

// The repo's config.yaml is copied into each test's temp dir, never written.
let repoConfigBefore = "";
beforeAll(() => { repoConfigBefore = readFileSync(REPO_CONFIG, "utf-8"); });
afterAll(() => { expect(readFileSync(REPO_CONFIG, "utf-8")).toBe(repoConfigBefore); });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-2113-"));
  copyFileSync(REPO_CONFIG, join(dir, "config.yaml"));
});
afterEach(() => {
  try { chmodSync(join(dir, "config.yaml"), 0o644); } catch { /* removed by the test */ }
  rmSync(dir, { recursive: true, force: true });
});

function paths() {
  return {
    signingKeyFilePath: join(dir, "signing-key.pem"),
    secretsStagingPath: join(dir, "secrets.env"),
    localConfigPath: join(dir, "config.yaml"),
  };
}

const BASE = {
  instance: ISSUER,
  idpClientId: "client-id",
  idpClientSecret: "client-secret",
  idpSubject: "octocat",
  adminUser: "admin",
  adminPass: "pw",
};

const CIMD_METADATA = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/oauth/mcp/token`,
  client_id_metadata_document_supported: true,
  token_endpoint_auth_methods_supported: ["none"],
};

// What the fake target's ops API reports about itself (system_information with
// the "system" attribute), and the seams that make this machine agree with it.
const TEST_HOST = "flair-2113-test-host";
const TARGET_PID = 4242;
type TargetReport = { hostname?: string; pid?: number } | { status: number } | { throws: string };

/**
 * `checkTargetRunsFromConfig` seams: this machine is TEST_HOST, and TARGET_PID
 * is a Harper process working in `cwd`, started as `harper run <appArg>`.
 */
function targetRunsFrom(cwd: string | null, cmdline: string | null = "node /pkg/node_modules/harper/dist/bin/harper.js run .") {
  return {
    readProcessCwd: (pid: number) => (pid === TARGET_PID ? cwd : null),
    readProcessCmdline: (pid: number) => (pid === TARGET_PID ? cmdline : null),
    localHostname: () => TEST_HOST,
  };
}

/**
 * Injected fetch for the whole flow. Every request must target the fake
 * instance's host; anything else is recorded and fails the test. `onRestart`
 * runs when the ops-API restart arrives, so a test can read the config file
 * at the moment the instance would reload it. `target` is what the target
 * check's system_information call gets back.
 */
function mockFetch(
  host: string,
  opts: { onRestart?: () => void; target?: TargetReport } = {},
) {
  const onRestart = opts.onRestart;
  const target: TargetReport = opts.target ?? { hostname: TEST_HOST, pid: TARGET_PID };
  const calls: string[] = [];
  const foreign: string[] = [];
  const creds = new Map<string, any>();
  let sysInfo = 0;
  const fetchImpl = (async (url: any, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname !== host) {
      foreign.push(String(url));
      return new Response("refused by test", { status: 599 });
    }
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      calls.push("self-verify");
      return new Response(JSON.stringify(CIMD_METADATA), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.operation === "system_information" && (body.attributes ?? []).includes("system")) {
      calls.push("target-check");
      if ("throws" in target) throw new Error(target.throws);
      if ("status" in target) return new Response("{}", { status: target.status });
      return new Response(
        JSON.stringify({ system: { hostname: target.hostname }, harperdb_processes: { core: [{ pid: target.pid }] } }),
        { status: 200 },
      );
    }
    calls.push(`ops:${body.operation}`);
    if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
    if (body.operation === "search_by_conditions") {
      return new Response(JSON.stringify([...creds.values()]), { status: 200 });
    }
    if (body.operation === "upsert") {
      for (const r of body.records ?? []) creds.set(String(r.id), { ...(creds.get(String(r.id)) ?? {}), ...r });
      return new Response(JSON.stringify({ message: "upserted" }), { status: 200 });
    }
    if (body.operation === "system_information") {
      sysInfo++;
      return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid: sysInfo === 1 ? 111 : 222 }] } }), { status: 200 });
    }
    if (body.operation === "restart") onRestart?.();
    return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, foreign };
}

// ─── validation ─────────────────────────────────────────────────────────────

describe("validateCimdAllowedHosts / cimdAllowedHostsFromFlag — input", () => {
  test("accepts lowercase bare hostnames and trims spaces around commas", () => {
    expect(cimdAllowedHostsFromFlag(" claude.ai , flair.example.com", ISSUER)).toEqual({
      hosts: ["claude.ai", "flair.example.com"],
    });
  });

  test("no flag: nothing to set", () => {
    expect(cimdAllowedHostsFromFlag(undefined, ISSUER)).toEqual({});
  });

  const REFUSED: [string, string][] = [
    ["", "no hostnames given"],
    ["   ", "no hostnames given"],
    [",claude.ai", "entry 1 is empty"],
    ["claude.ai,", "entry 2 is empty"],
    ["claude.ai,,flair.example.com", "entry 2 is empty"],
    ["https://claude.ai", "is a URL or path"],
    ["claude.ai/mcp", "is a URL or path"],
    ["claude.ai:443", 'contains ":" (a port or scheme)'],
    ["[::1]", "looks like an IPv6 address"],
    ["::1", "looks like an IPv6 address"],
    ["*.claude.ai", "is a wildcard"],
    ["Claude.ai", "has uppercase letters"],
    ["1.2.3.4", "ends in a numeric label"],
    ["claude.ai.", "is not a valid hostname"],
    ["under_score.example.com", "is not a valid hostname"],
    ["-lead.example.com", "is not a valid hostname"],
    ["claude.ai,claude.ai", "repeats an earlier entry"],
  ];
  for (const [raw, why] of REFUSED) {
    test(`refuses ${JSON.stringify(raw)} with CimdAllowedHostsError: ${why}`, () => {
      expect(() => validateCimdAllowedHosts(raw.split(","))).toThrow(CimdAllowedHostsError);
      expect(() => validateCimdAllowedHosts(raw.split(","))).toThrow(why);
      const flag = cimdAllowedHostsFromFlag(raw, ISSUER);
      expect(flag.hosts).toBeUndefined();
      expect(flag.error).toContain("--cimd-allowed-hosts");
      expect(flag.error).toContain(why);
    });
  }

  test("an empty list is refused, never passed on as []", () => {
    expect(() => validateCimdAllowedHosts([])).toThrow(CimdAllowedHostsError);
    expect(() => validateCimdAllowedHosts([])).toThrow("no hostnames given");
  });
});

// ─── shape ──────────────────────────────────────────────────────────────────

describe("cimdAllowedHostsShapeRefusal — which targets can take the flag", () => {
  test("a Fabric origin is refused, naming the config key", () => {
    const msg = cimdAllowedHostsShapeRefusal(FABRIC_ISSUER);
    expect(msg).toContain("mcp.clientIdMetadataDocuments.allowedHosts");
    expect(msg).toContain("my-flair.harperfabric.com");
    expect(cimdAllowedHostsFromFlag("claude.ai", FABRIC_ISSUER)).toEqual({ error: msg! });
  });

  test("a non-Fabric origin is not refused", () => {
    expect(cimdAllowedHostsShapeRefusal(ISSUER)).toBeNull();
  });
});

// ─── target runs from the edited config.yaml: the list the component reads ──

describe("enableMcp, non-Fabric target — the clientIdMetadataDocuments.allowedHosts the component reads", () => {
  test("the component reads the default claude.ai + claude.com from the shipped config.yaml", () => {
    expect(componentAllowedHosts(REPO_CONFIG)).toEqual(DEFAULT_CIMD_ALLOWED_HOSTS);
    expect(DEFAULT_CIMD_ALLOWED_HOSTS).toEqual(["claude.ai", "claude.com"]);
  });

  test("no flag: the list stays claude.ai + claude.com and the file is not rewritten", async () => {
    const p = paths();
    const before = readFileSync(p.localConfigPath, "utf-8");
    const { fetchImpl, foreign } = mockFetch("flair.example.com");
    const result = await enableMcp({ ...BASE, ...p, confirmSecretsApplied: true }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(foreign).toEqual([]);
    expect(readFileSync(p.localConfigPath, "utf-8")).toBe(before);
    expect(componentAllowedHosts(p.localConfigPath)).toEqual(["claude.ai", "claude.com"]);
    expect(result.cimdAllowedHosts).toBeUndefined();
    expect(result.steps.some((s) => s.step === "cimd-allowed-hosts")).toBe(false);
  });

  test("with the flag and a target running from that file: the component reads the new list, written before the restart", async () => {
    const p = paths();
    let atRestart: unknown = "restart never called";
    const { fetchImpl, calls, foreign } = mockFetch("flair.example.com", {
      onRestart: () => { atRestart = componentAllowedHosts(p.localConfigPath); },
    });
    const hosts = ["flair.example.com", "claude.ai"];
    const result = await enableMcp(
      { ...BASE, ...p, cimdAllowedHosts: hosts, confirmSecretsApplied: true },
      { fetchImpl, ...targetRunsFrom(dir) },
    );

    expect(result.ok).toBe(true);
    expect(foreign).toEqual([]);
    expect(calls).toContain("ops:restart");
    expect(atRestart).toEqual(hosts);
    expect(componentAllowedHosts(p.localConfigPath)).toEqual(hosts);
    // The printed/returned list is the read-back, and names the file.
    expect(result.cimdAllowedHosts).toEqual(hosts);
    expect(result.cimdAllowedHostsConfigPath).toBe(p.localConfigPath);
    // The target was checked first, before any other call.
    expect(calls[0]).toBe("target-check");
    const written = result.steps.filter((s) => s.step === "local-config-update" && s.detail.includes("allowedHosts"));
    expect(written).toHaveLength(1);
    expect(written[0].ok).toBe(true);
    expect(written[0].detail).toContain(JSON.stringify(hosts));
    expect(written[0].detail).toContain(p.localConfigPath);
  });

  test("the edit replaces only the list's lines; every comment and other line is kept", async () => {
    const p = paths();
    const before = readFileSync(p.localConfigPath, "utf-8").split("\n");
    const { fetchImpl } = mockFetch("flair.example.com");
    const result = await enableMcp(
      { ...BASE, ...p, cimdAllowedHosts: ["flair.example.com"], confirmSecretsApplied: true },
      { fetchImpl, ...targetRunsFrom(dir) },
    );
    expect(result.ok).toBe(true);
    expect(result.steps.some((s) => s.detail.includes("only the list's own lines were rewritten"))).toBe(true);
    const after = readFileSync(p.localConfigPath, "utf-8").split("\n");
    const start = before.findIndex((l) => l.trim() === "allowedHosts:");
    expect(start).toBeGreaterThan(-1);
    // Shipped shape: the key line plus two items.
    expect(after.slice(0, start + 1)).toEqual(before.slice(0, start + 1));
    expect(after[start + 1].trim()).toBe(`- "flair.example.com"`);
    expect(after.slice(start + 2)).toEqual(before.slice(start + 3));
  });

  test("a file without the list gets it added, and the component reads it", () => {
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, `name: flair\n"@harperfast/oauth":\n  package: "@harperfast/oauth"\n  mcp:\n    enabled: false\n`);
    const res = updateLocalConfigCimdAllowedHosts(["flair.example.com"], configPath);
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("re-emitted");
    expect(res.readBack).toEqual(["flair.example.com"]);
    expect(componentAllowedHosts(configPath)).toEqual(["flair.example.com"]);
  });

  // Other shapes an operator's config.yaml may carry. Whichever path the writer
  // takes (line edit or re-emit), the component must read exactly the new list.
  const SHAPES: [string, string][] = [
    ["flow sequence", `"@harperfast/oauth":\n  mcp:\n    # keep me\n    clientIdMetadataDocuments:\n      allowedHosts: [claude.ai, claude.com]\n    signingKeyPem: x\n`],
    ["items at the key's indent", `"@harperfast/oauth":\n  mcp:\n    clientIdMetadataDocuments:\n      allowedHosts:\n      - claude.ai\n      # between\n      - claude.com\n    signingKeyPem: x\n`],
    ["CRLF line endings", `"@harperfast/oauth":\r\n  mcp:\r\n    clientIdMetadataDocuments:\r\n      allowedHosts:\r\n        - claude.ai\r\n    signingKeyPem: x\r\n`],
    ["env reference", `"@harperfast/oauth":\n  mcp:\n    clientIdMetadataDocuments:\n      allowedHosts: \${SOME_VAR}\n    signingKeyPem: x\n`],
    ["folded scalar", `"@harperfast/oauth":\n  mcp:\n    clientIdMetadataDocuments:\n      allowedHosts: >-\n        claude.ai\n    signingKeyPem: x\n`],
    ["multi-line flow sequence", `"@harperfast/oauth":\n  mcp:\n    clientIdMetadataDocuments:\n      allowedHosts: [claude.ai,\n        claude.com]\n    signingKeyPem: x\n`],
  ];
  for (const [name, text] of SHAPES) {
    test(`writer, ${name}: the component reads the new list and signingKeyPem beside it is kept`, () => {
      const configPath = join(dir, "config.yaml");
      writeFileSync(configPath, text);
      const res = updateLocalConfigCimdAllowedHosts(["flair.example.com", "claude.ai"], configPath);
      expect(res.ok).toBe(true);
      expect(componentAllowedHosts(configPath)).toEqual(["flair.example.com", "claude.ai"]);
      const root = harperYaml.parse(readFileSync(configPath, "utf-8"));
      expect(root["@harperfast/oauth"].mcp.signingKeyPem).toBe("x");
    });
  }

  test("--dry-run with the flag reports the change and leaves config.yaml untouched", async () => {
    const p = paths();
    const before = readFileSync(p.localConfigPath, "utf-8");
    const { fetchImpl, calls } = mockFetch("flair.example.com");
    const result = await enableMcp({ ...BASE, ...p, cimdAllowedHosts: ["flair.example.com"], dryRun: true }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(readFileSync(p.localConfigPath, "utf-8")).toBe(before);
    const step = result.steps.find((s) => s.step === "cimd-allowed-hosts");
    expect(step?.ok).toBe(true);
    expect(step?.detail).toContain("the target was not checked, and the list was not written");
    expect(existsSync(p.signingKeyFilePath)).toBe(false);
    expect(result.cimdAllowedHosts).toBeUndefined();
  });
});

// ─── refusals and failed writes: never a silent accept ──────────────────────

describe("enableMcp — the flag is refused, or fails loudly, where it cannot take effect", () => {
  test("Fabric origin: refused at the cimd-allowed-hosts step, before any change — no call, no key, no staged file", async () => {
    const p = paths();
    const { fetchImpl, calls } = mockFetch("my-flair.harperfabric.com");
    for (const dryRun of [false, true]) {
      const result = await enableMcp(
        { ...BASE, ...p, instance: FABRIC_ISSUER, cimdAllowedHosts: ["claude.ai"], confirmSecretsApplied: true, dryRun },
        { fetchImpl },
      );
      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe("cimd-allowed-hosts");
      expect(result.refused?.message).toContain("mcp.clientIdMetadataDocuments.allowedHosts");
      expect(result.steps.map((s) => s.step)).toEqual(["local-origin-check", "cimd-allowed-hosts"]);
    }
    expect(calls).toEqual([]);
    expect(existsSync(p.signingKeyFilePath)).toBe(false);
    expect(existsSync(p.secretsStagingPath)).toBe(false);
  });

  test("invalid hosts: refused before any change", async () => {
    const p = paths();
    const before = readFileSync(p.localConfigPath, "utf-8");
    const { fetchImpl, calls } = mockFetch("flair.example.com");
    for (const bad of [["https://claude.ai"], [], ["claude.ai:443"], ["*.example.com"], ["Claude.ai"], [""]]) {
      const result = await enableMcp({ ...BASE, ...p, cimdAllowedHosts: bad, confirmSecretsApplied: true }, { fetchImpl });
      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe("cimd-allowed-hosts");
      expect(result.refused?.message).toContain("--cimd-allowed-hosts");
    }
    expect(calls).toEqual([]);
    expect(existsSync(p.signingKeyFilePath)).toBe(false);
    expect(readFileSync(p.localConfigPath, "utf-8")).toBe(before);
  });

  test("no component config.yaml to write: refused before any change, naming the key", async () => {
    const p = { ...paths(), localConfigPath: join(dir, "missing", "config.yaml") };
    const { fetchImpl, calls } = mockFetch("flair.example.com");
    const result = await enableMcp({ ...BASE, ...p, cimdAllowedHosts: ["claude.ai"], confirmSecretsApplied: true }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("cimd-allowed-hosts");
    expect(result.refused?.message).toContain("mcp.clientIdMetadataDocuments.allowedHosts");
    expect(calls).toEqual([]);
  });

  test("a config.yaml without the @harperfast/oauth mcp block: refused before any change", async () => {
    const p = paths();
    writeFileSync(p.localConfigPath, "port: 9926\n");
    const { fetchImpl, calls } = mockFetch("flair.example.com");
    const result = await enableMcp({ ...BASE, ...p, cimdAllowedHosts: ["claude.ai"], confirmSecretsApplied: true }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("cimd-allowed-hosts");
    expect(result.refused?.message).toContain("no @harperfast/oauth");
    expect(calls).toEqual([]);
    expect(readFileSync(p.localConfigPath, "utf-8")).toBe("port: 9926\n");
  });

  test("the write fails: the step fails and the instance is NOT restarted", async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    const p = paths();
    chmodSync(p.localConfigPath, 0o444);
    const { fetchImpl, calls } = mockFetch("flair.example.com");
    const result = await enableMcp(
      { ...BASE, ...p, cimdAllowedHosts: ["flair.example.com"], confirmSecretsApplied: true },
      { fetchImpl, ...targetRunsFrom(dir) },
    );
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("local-config-update");
    expect(calls).not.toContain("ops:restart");
    expect(result.cimdAllowedHosts).toBeUndefined();
    const failed = result.steps.find((s) => s.step === "local-config-update" && !s.ok);
    expect(failed?.detail).toContain("not restarted");
    expect(componentAllowedHosts(p.localConfigPath)).toEqual(["claude.ai", "claude.com"]);
  });
});

describe("updateLocalConfigCimdAllowedHosts — the read-back decides, never the intent", () => {
  test("a write that does not land is reported as a failure", () => {
    const configPath = join(dir, "config.yaml");
    const res = updateLocalConfigCimdAllowedHosts(["flair.example.com"], configPath, { writeFile: () => {} });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("reads back");
    expect(res.readBack).toBeUndefined();
  });

  test("a read-back that fails is reported as a failure", () => {
    const configPath = join(dir, "config.yaml");
    let reads = 0;
    const res = updateLocalConfigCimdAllowedHosts(["flair.example.com"], configPath, {
      readFile: (path) => {
        reads++;
        if (reads > 1) throw new Error("EIO: simulated");
        return readFileSync(path, "utf-8");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("could not read it back");
    expect(res.readBack).toBeUndefined();
  });

  test("the writer refuses an invalid list itself, and writes nothing", () => {
    const configPath = join(dir, "config.yaml");
    const before = readFileSync(configPath, "utf-8");
    for (const bad of [[], ["https://claude.ai"], ["*.claude.ai"]]) {
      const res = updateLocalConfigCimdAllowedHosts(bad, configPath);
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("--cimd-allowed-hosts");
    }
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });
});

describe("claudeAiExcludedNote — the note matches the list this run ensured and read back (written unless the file already held that exact list)", () => {
  test("no list ensured and read back, or one that includes claude.ai: no note", () => {
    expect(claudeAiExcludedNote(undefined)).toBeNull();
    expect(claudeAiExcludedNote(["flair.example.com", "claude.ai"])).toBeNull();
  });

  test("a list without claude.ai: says claude.ai is refused, and how to fix it", () => {
    const note = claudeAiExcludedNote(["flair.example.com", "claude.com"]);
    expect(note).toContain("claude.ai is not in the mcp.clientIdMetadataDocuments.allowedHosts list");
    expect(note).toContain("is refused");
    expect(note).toContain(JSON.stringify(["flair.example.com", "claude.com"]));
    expect(note).toContain("--cimd-allowed-hosts");
  });
});

// ─── the preflight match ──────────────────────────────────────────────────────

describe("enableMcp — without --dry-run, the flag is refused unless the preflight match passes", () => {
  let other: string;
  beforeEach(() => {
    other = mkdtempSync(join(tmpdir(), "flair-2113-target-"));
    copyFileSync(REPO_CONFIG, join(other, "config.yaml"));
  });
  afterEach(() => {
    rmSync(other, { recursive: true, force: true });
  });

  /** Run enable with the flag; assert it was refused at the target check with nothing changed. */
  async function expectRefusedUnchanged(target: TargetReport, seams: ReturnType<typeof targetRunsFrom>, why: string) {
    const p = paths();
    const localBefore = readFileSync(p.localConfigPath, "utf-8");
    const otherBefore = readFileSync(join(other, "config.yaml"), "utf-8");
    const { fetchImpl, calls } = mockFetch("flair.example.com", { target });
    const result = await enableMcp(
      { ...BASE, ...p, cimdAllowedHosts: ["flair.example.com"], confirmSecretsApplied: true },
      { fetchImpl, ...seams },
    );
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("cimd-allowed-hosts");
    expect(result.refused?.message).toContain("mcp.clientIdMetadataDocuments.allowedHosts");
    expect(result.refused?.message).toContain("by hand in the config.yaml the target runs from, on its host");
    expect(result.refused?.message).toContain(why);
    // The one call made is the read-only target check; nothing after it ran.
    expect(calls).toEqual(["target-check"]);
    expect(existsSync(p.signingKeyFilePath)).toBe(false);
    expect(existsSync(p.secretsStagingPath)).toBe(false);
    expect(readFileSync(p.localConfigPath, "utf-8")).toBe(localBefore);
    expect(readFileSync(join(other, "config.yaml"), "utf-8")).toBe(otherBefore);
    expect(result.cimdAllowedHosts).toBeUndefined();
  }

  test("distinct local and target configs: the target runs from another directory — refused, nothing written", async () => {
    await expectRefusedUnchanged({ hostname: TEST_HOST, pid: TARGET_PID }, targetRunsFrom(other), `application directory ${other}`);
  });

  test("the target works in the edited file's directory but was started with another application directory — refused, nothing written", async () => {
    await expectRefusedUnchanged(
      { hostname: TEST_HOST, pid: TARGET_PID },
      targetRunsFrom(dir, `node harper.js run ${other}`),
      `application directory ${other}`,
    );
  });

  test("the target's command line cannot be read, or names no run/dev application — refused, nothing written", async () => {
    await expectRefusedUnchanged({ hostname: TEST_HOST, pid: TARGET_PID }, targetRunsFrom(dir, null), "could not be read from its command line");
    await expectRefusedUnchanged({ hostname: TEST_HOST, pid: TARGET_PID }, targetRunsFrom(dir, "node harper.js start"), "could not be read from its command line");
  });

  test("the target reports another host — refused, nothing written", async () => {
    await expectRefusedUnchanged({ hostname: "some-other-host", pid: TARGET_PID }, targetRunsFrom(dir), "this machine is");
  });

  test("the target's process cannot be found on this machine — refused, nothing written", async () => {
    await expectRefusedUnchanged({ hostname: TEST_HOST, pid: TARGET_PID }, targetRunsFrom(null), "could not be read on this machine");
  });

  test("the target check gets HTTP 401 — refused, nothing written", async () => {
    await expectRefusedUnchanged({ status: 401 }, targetRunsFrom(dir), "HTTP 401");
  });

  test("the target check cannot reach the ops API — refused, nothing written", async () => {
    await expectRefusedUnchanged({ throws: "ECONNREFUSED" }, targetRunsFrom(dir), "ECONNREFUSED");
  });

  test("the target does not report its hostname or process id — refused, nothing written", async () => {
    await expectRefusedUnchanged({ pid: TARGET_PID }, targetRunsFrom(dir), "did not report both its hostname and its Harper process id");
    await expectRefusedUnchanged({ hostname: TEST_HOST }, targetRunsFrom(dir), "did not report both its hostname and its Harper process id");
  });
});

describe("checkTargetRunsFromConfig — against a real process on this machine", () => {
  test("matches a live process's working directory, and rejects another directory", async () => {
    const other = mkdtempSync(join(tmpdir(), "flair-2113-other-"));
    copyFileSync(REPO_CONFIG, join(other, "config.yaml"));
    // Started like flair starts Harper: `... run .` in the application directory.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "run", "."], { cwd: dir, stdio: "ignore" });
    try {
      const pid = child.pid!;
      expect(pid).toBeGreaterThan(0);
      const report = { hostname: hostname(), pid };
      const fetchImpl = (async (url: any) => {
        expect(new URL(String(url)).hostname).toBe("flair.example.com");
        return new Response(JSON.stringify({ system: { hostname: report.hostname }, harperdb_processes: { core: [{ pid }] } }), { status: 200 });
      }) as typeof fetch;
      // The default process cwd and command-line readers, and this machine's real hostname.
      let result = { ok: false, detail: "not run" };
      for (let i = 0; i < 40 && !result.ok; i++) {
        result = await checkTargetRunsFromConfig(ISSUER, "admin", "pw", join(dir, "config.yaml"), { fetchImpl });
        if (!result.ok) await new Promise((r) => setTimeout(r, 50));
      }
      expect(result.detail).toContain(`pid ${pid}`);
      expect(result.ok).toBe(true);
      const elsewhere = await checkTargetRunsFromConfig(ISSUER, "admin", "pw", join(other, "config.yaml"), { fetchImpl });
      expect(elsewhere.ok).toBe(false);
      expect(elsewhere.detail).toContain("config.yaml is not");
    } finally {
      child.kill("SIGKILL");
      rmSync(other, { recursive: true, force: true });
    }
  }, 15000);
});

describe("harperAppDirFromCmdline — the application directory a Harper command line names", () => {
  test("run/dev with ., a relative or an absolute directory, or none", () => {
    expect(harperAppDirFromCmdline("node /x/harper.js run .", "/srv/flair")).toBe("/srv/flair");
    expect(harperAppDirFromCmdline("node /x/harper.js run app", "/srv")).toBe("/srv/app");
    expect(harperAppDirFromCmdline("node /x/harper.js run /opt/flair", "/srv")).toBe("/opt/flair");
    expect(harperAppDirFromCmdline("node\0/x/harper.js\0dev\0.\0", "/srv/flair")).toBe("/srv/flair");
    expect(harperAppDirFromCmdline("node /x/harper.js run", "/srv/flair")).toBe("/srv/flair");
    expect(harperAppDirFromCmdline("node /x/harper.js run --foo", "/srv/flair")).toBe("/srv/flair");
  });

  test("no run/dev action: null, never a guess", () => {
    expect(harperAppDirFromCmdline("node /x/harper.js start", "/srv/flair")).toBeNull();
    expect(harperAppDirFromCmdline("", "/srv/flair")).toBeNull();
  });
});
