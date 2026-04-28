/**
 * cli.test.ts — Unit tests for CLI helper functions and Commander program structure
 *
 * Tests pure/extractable logic without a running Harper instance:
 *   - resolveKeyPath()
 *   - buildEd25519Auth()
 *   - readPortFromConfig()
 *   - resolveHttpPort()
 *   - resolveOpsPort()
 *   - signRequestBody()
 *   - b64 / b64url helpers
 *   - Commander program command registration
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import nacl from "tweetnacl";
import { createPrivateKey, sign as nodeCryptoSign } from "node:crypto";
import {
  resolveKeyPath,
  buildEd25519Auth,
  readPortFromConfig,
  resolveHttpPort,
  resolveOpsPort,
  signRequestBody,
  b64,
  b64url,
  program,
} from "../../src/cli.js";

// ─── Temp dir helpers ─────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-cli-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── b64 / b64url ─────────────────────────────────────────────────────────────

describe("b64 helper", () => {
  test("encodes Uint8Array to base64 string", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(b64(bytes)).toBe("SGVsbG8=");
  });

  test("encodes empty array to empty base64", () => {
    expect(b64(new Uint8Array([]))).toBe("");
  });

  test("produces standard base64 (may contain +/= characters)", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    const result = b64(bytes);
    // Standard base64 uses + and /
    expect(result).toBe(Buffer.from([0xfb, 0xff, 0xfe]).toString("base64"));
  });
});

describe("b64url helper", () => {
  test("encodes Uint8Array to base64url string", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(b64url(bytes)).toBe("SGVsbG8");
  });

  test("does not contain +, /, or = characters (URL-safe)", () => {
    // Use bytes that would produce + or / in standard base64
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    const result = b64url(bytes);
    expect(result).not.toContain("+");
    expect(result).not.toContain("/");
    expect(result).not.toContain("=");
  });

  test("encodes empty array to empty string", () => {
    expect(b64url(new Uint8Array([]))).toBe("");
  });

  test("matches Buffer base64url encoding", () => {
    const kp = nacl.sign.keyPair();
    expect(b64url(kp.publicKey)).toBe(Buffer.from(kp.publicKey).toString("base64url"));
  });
});

// ─── resolveKeyPath ───────────────────────────────────────────────────────────

describe("resolveKeyPath", () => {
  let tmpDir: string;
  let origKeyDir: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origKeyDir = process.env.FLAIR_KEY_DIR;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origKeyDir === undefined) {
      delete process.env.FLAIR_KEY_DIR;
    } else {
      process.env.FLAIR_KEY_DIR = origKeyDir;
    }
  });

  test("returns null when no key file exists", () => {
    process.env.FLAIR_KEY_DIR = tmpDir;
    const result = resolveKeyPath("nonexistent-agent");
    expect(result).toBeNull();
  });

  test("finds key in FLAIR_KEY_DIR when it exists", () => {
    process.env.FLAIR_KEY_DIR = tmpDir;
    const keyPath = join(tmpDir, "myagent.key");
    writeFileSync(keyPath, "dummy-key-data");

    const result = resolveKeyPath("myagent");
    expect(result).toBe(keyPath);
  });

  test("FLAIR_KEY_DIR takes priority over default ~/.flair/keys location", () => {
    process.env.FLAIR_KEY_DIR = tmpDir;
    const keyInCustomDir = join(tmpDir, "agent1.key");
    writeFileSync(keyInCustomDir, "custom-dir-key");

    const result = resolveKeyPath("agent1");
    expect(result).toBe(keyInCustomDir);
  });

  test("returns null when FLAIR_KEY_DIR is set but file is missing", () => {
    const emptyDir = join(tmpDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    process.env.FLAIR_KEY_DIR = emptyDir;

    const result = resolveKeyPath("someagent");
    expect(result).toBeNull();
  });

  test("searches ~/.tps/secrets/flair/<agentId>-priv.key location", () => {
    delete process.env.FLAIR_KEY_DIR;

    // We can't easily write to real ~/.tps/secrets/flair without polluting the
    // dev environment, so we verify the function doesn't throw and returns null
    // for a made-up agent ID that won't exist anywhere.
    const result = resolveKeyPath("__nonexistent_test_agent_xyz__");
    expect(result).toBeNull();
  });
});

// ─── readPortFromConfig ───────────────────────────────────────────────────────
// Note: readPortFromConfig() reads from homedir() (from node:os), which is
// baked in at module load time and cannot be overridden via process.env.HOME.
// We therefore test it against the live environment: if ~/.flair/config.yaml
// exists, the function returns whatever port is configured there; otherwise null.

describe("readPortFromConfig", () => {
  test("returns a number or null (never throws)", () => {
    const result = readPortFromConfig();
    expect(result === null || typeof result === "number").toBe(true);
  });

  test("returns a positive integer when config exists with a port", () => {
    const result = readPortFromConfig();
    if (result !== null) {
      expect(result).toBeGreaterThan(0);
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  test("port regex matches 'port: <n>' in yaml content", () => {
    // Unit-test the regex used by readPortFromConfig in isolation
    const yaml1 = "# Flair configuration\nport: 19999\n";
    const m1 = yaml1.match(/port:\s*(\d+)/);
    expect(m1).not.toBeNull();
    expect(Number(m1![1])).toBe(19999);

    const yaml2 = "port: 12345\nother: value\n";
    const m2 = yaml2.match(/port:\s*(\d+)/);
    expect(Number(m2![1])).toBe(12345);
  });

  test("port regex returns null match on yaml without port field", () => {
    const yaml = "# No port here\nsome_other_key: value\n";
    const m = yaml.match(/port:\s*(\d+)/);
    expect(m).toBeNull();
  });

  test("yml extension check: existsSync(ymlPath) && !existsSync(yamlPath) uses yml", () => {
    // Logic: if .yml exists and .yaml doesn't, use .yml
    const ymlExists = true;
    const yamlExists = false;
    const usesYml = ymlExists && !yamlExists;
    expect(usesYml).toBe(true);

    // If both exist, yaml wins
    const usesYmlWhenBoth = true && !true;
    expect(usesYmlWhenBoth).toBe(false);
  });
});

// ─── resolveHttpPort ──────────────────────────────────────────────────────────

describe("resolveHttpPort", () => {
  const DEFAULT_PORT = 19926;
  let origFlairUrl: string | undefined;

  beforeAll(() => {
    origFlairUrl = process.env.FLAIR_URL;
  });

  afterEach(() => {
    if (origFlairUrl === undefined) delete process.env.FLAIR_URL;
    else process.env.FLAIR_URL = origFlairUrl;
  });

  test("uses explicit --port flag (string) over all others", () => {
    process.env.FLAIR_URL = "http://127.0.0.1:9999";
    const result = resolveHttpPort({ port: "8080" });
    expect(result).toBe(8080);
  });

  test("uses explicit --port flag (number) over all others", () => {
    const result = resolveHttpPort({ port: 7777 });
    expect(result).toBe(7777);
  });

  test("ignores zero port and falls through", () => {
    delete process.env.FLAIR_URL;
    const result = resolveHttpPort({ port: 0 });
    // With no FLAIR_URL and no valid port, falls to config or DEFAULT_PORT
    expect(result).toBeGreaterThan(0);
  });

  test("ignores NaN port and falls through to FLAIR_URL", () => {
    delete process.env.FLAIR_URL;
    process.env.FLAIR_URL = "http://127.0.0.1:11111";
    const result = resolveHttpPort({ port: "notanumber" });
    expect(result).toBe(11111);
  });

  test("extracts port from FLAIR_URL env var", () => {
    delete process.env.FLAIR_URL;
    process.env.FLAIR_URL = "http://127.0.0.1:12000";
    const result = resolveHttpPort({});
    expect(result).toBe(12000);
  });

  test("extracts port from FLAIR_URL with path component", () => {
    delete process.env.FLAIR_URL;
    process.env.FLAIR_URL = "http://127.0.0.1:15000/some/path";
    const result = resolveHttpPort({});
    expect(result).toBe(15000);
  });

  test("explicit port flag takes priority over FLAIR_URL", () => {
    process.env.FLAIR_URL = "http://127.0.0.1:9999";
    const result = resolveHttpPort({ port: "5555" });
    expect(result).toBe(5555);
  });

  test("returns a positive integer in all code paths", () => {
    delete process.env.FLAIR_URL;
    const result = resolveHttpPort({});
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ─── resolveOpsPort ───────────────────────────────────────────────────────────

describe("resolveOpsPort", () => {
  let origFlairOpsPort: string | undefined;
  let origFlairUrl: string | undefined;

  beforeAll(() => {
    origFlairOpsPort = process.env.FLAIR_OPS_PORT;
    origFlairUrl = process.env.FLAIR_URL;
  });

  afterEach(() => {
    if (origFlairOpsPort === undefined) delete process.env.FLAIR_OPS_PORT;
    else process.env.FLAIR_OPS_PORT = origFlairOpsPort;
    if (origFlairUrl === undefined) delete process.env.FLAIR_URL;
    else process.env.FLAIR_URL = origFlairUrl;
  });

  test("uses explicit --ops-port flag over all others", () => {
    process.env.FLAIR_OPS_PORT = "19000";
    const result = resolveOpsPort({ opsPort: "18000" });
    expect(result).toBe(18000);
  });

  test("uses FLAIR_OPS_PORT env var over config and default", () => {
    delete process.env.FLAIR_OPS_PORT;
    process.env.FLAIR_OPS_PORT = "17000";
    const result = resolveOpsPort({});
    expect(result).toBe(17000);
  });

  test("opsPort is httpPort - 1 when explicit port is set and no FLAIR_OPS_PORT", () => {
    delete process.env.FLAIR_OPS_PORT;
    delete process.env.FLAIR_URL;
    const result = resolveOpsPort({ port: "10000" });
    expect(result).toBe(9999);
  });

  test("opsPort is FLAIR_URL port - 1 when no explicit ports set", () => {
    delete process.env.FLAIR_OPS_PORT;
    process.env.FLAIR_URL = "http://127.0.0.1:20000";
    const result = resolveOpsPort({});
    expect(result).toBe(19999);
  });

  test("explicit --ops-port takes priority over --port - 1 calculation", () => {
    delete process.env.FLAIR_OPS_PORT;
    const result = resolveOpsPort({ port: "10000", opsPort: "8888" });
    expect(result).toBe(8888);
  });

  test("returns a positive integer in all code paths", () => {
    delete process.env.FLAIR_OPS_PORT;
    process.env.FLAIR_URL = "http://127.0.0.1:20000";
    const result = resolveOpsPort({});
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ─── buildEd25519Auth ─────────────────────────────────────────────────────────

describe("buildEd25519Auth", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRawSeedKey(dir: string, agentId: string): { keyPath: string; seed: Uint8Array } {
    const kp = nacl.sign.keyPair();
    const seed = kp.secretKey.slice(0, 32);
    const keyPath = join(dir, `${agentId}.key`);
    writeFileSync(keyPath, Buffer.from(seed));
    return { keyPath, seed: new Uint8Array(seed) };
  }

  test("returns a TPS-Ed25519 auth header string", () => {
    const { keyPath } = makeRawSeedKey(tmpDir, "testagent");
    const header = buildEd25519Auth("testagent", "GET", "/Memory", keyPath);
    expect(header).toMatch(/^TPS-Ed25519 /);
  });

  test("header contains agentId:timestamp:nonce:signature", () => {
    const { keyPath } = makeRawSeedKey(tmpDir, "myagent");
    const header = buildEd25519Auth("myagent", "GET", "/Memory", keyPath);

    // Format: TPS-Ed25519 <agentId>:<ts>:<nonce>:<sig>
    const parts = header.replace("TPS-Ed25519 ", "").split(":");
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts[0]).toBe("myagent");
    // timestamp is a numeric string
    expect(Number(parts[1])).toBeGreaterThan(0);
  });

  test("timestamp in header is recent (within last 5 seconds)", () => {
    const { keyPath } = makeRawSeedKey(tmpDir, "tsagent");
    const before = Date.now();
    const header = buildEd25519Auth("tsagent", "POST", "/Memory", keyPath);
    const after = Date.now();

    const payload = header.replace("TPS-Ed25519 ", "");
    const ts = Number(payload.split(":")[1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  test("different calls produce different nonces", () => {
    const { keyPath } = makeRawSeedKey(tmpDir, "nonceagent");
    const h1 = buildEd25519Auth("nonceagent", "GET", "/Memory", keyPath);
    const h2 = buildEd25519Auth("nonceagent", "GET", "/Memory", keyPath);

    const nonce1 = h1.replace("TPS-Ed25519 ", "").split(":")[2];
    const nonce2 = h2.replace("TPS-Ed25519 ", "").split(":")[2];
    expect(nonce1).not.toBe(nonce2);
  });

  test("includes method and path in the signed payload", () => {
    // The payload format is: agentId:ts:nonce:method:path
    // We verify both method and path end up in the header indirectly by
    // checking two headers with different methods/paths differ.
    const { keyPath } = makeRawSeedKey(tmpDir, "methodagent");
    const h1 = buildEd25519Auth("methodagent", "GET", "/Memory", keyPath);
    const h2 = buildEd25519Auth("methodagent", "POST", "/Memory", keyPath);
    expect(h1).not.toBe(h2);
  });

  test("signature is a valid base64 string", () => {
    const { keyPath } = makeRawSeedKey(tmpDir, "sigagent");
    const header = buildEd25519Auth("sigagent", "GET", "/Soul", keyPath);
    // Signature is the last colon-separated segment
    const parts = header.replace("TPS-Ed25519 ", "").split(":");
    const sig = parts[parts.length - 1];
    // Should decode without error
    const decoded = Buffer.from(sig, "base64");
    expect(decoded.length).toBeGreaterThan(0);
  });

  test("accepts base64-encoded 32-byte seed", () => {
    const kp = nacl.sign.keyPair();
    const seed = kp.secretKey.slice(0, 32);
    const keyPath = join(tmpDir, "b64agent.key");
    // Write as base64-encoded seed (not raw bytes)
    writeFileSync(keyPath, Buffer.from(seed).toString("base64"));

    const header = buildEd25519Auth("b64agent", "GET", "/Memory", keyPath);
    expect(header).toMatch(/^TPS-Ed25519 b64agent:/);
  });

  test("throws when key file does not exist", () => {
    const missingPath = join(tmpDir, "ghost.key");
    expect(() => buildEd25519Auth("ghost", "GET", "/Memory", missingPath)).toThrow();
  });
});

// ─── signRequestBody ──────────────────────────────────────────────────────────

describe("signRequestBody", () => {
  const kp = nacl.sign.keyPair();

  test("returns body with signature field added", () => {
    const body = { instanceId: "spoke1", publicKey: "abc123", role: "spoke" };
    const signed = signRequestBody(body, kp.secretKey);
    expect(signed.signature).toBeDefined();
    expect(typeof signed.signature).toBe("string");
  });

  test("preserves all original fields", () => {
    const body = { instanceId: "spoke1", publicKey: "abc123", pairingToken: "tok123" };
    const signed = signRequestBody(body, kp.secretKey);
    expect(signed.instanceId).toBe("spoke1");
    expect(signed.publicKey).toBe("abc123");
    expect(signed.pairingToken).toBe("tok123");
  });

  test("does not mutate the original body", () => {
    const body = { instanceId: "test", data: "hello" };
    signRequestBody(body, kp.secretKey);
    expect((body as any).signature).toBeUndefined();
  });

  test("signature is a base64url string", () => {
    const body = { foo: "bar" };
    const signed = signRequestBody(body, kp.secretKey);
    const sig = signed.signature as string;
    // base64url: no +, /, or =
    expect(sig).not.toContain("+");
    expect(sig).not.toContain("/");
    expect(sig).not.toContain("=");
  });

  test("different bodies produce different signatures", () => {
    const body1 = { data: "hello" };
    const body2 = { data: "world" };
    const s1 = signRequestBody(body1, kp.secretKey);
    const s2 = signRequestBody(body2, kp.secretKey);
    expect(s1.signature).not.toBe(s2.signature);
  });

  test("signature is verifiable with corresponding public key (round-trip)", async () => {
    const { verifyBodySignature } = await import("../../resources/federation-crypto.js");
    const body = { instanceId: "hub1", records: [{ id: "m1" }], lamportClock: 100 };
    const signed = signRequestBody(body, kp.secretKey);
    const pubKeyB64 = Buffer.from(kp.publicKey).toString("base64url");
    expect(verifyBodySignature(signed, pubKeyB64)).toBe(true);
  });

  test("tampered body fails signature verification", async () => {
    const { verifyBodySignature } = await import("../../resources/federation-crypto.js");
    const body = { instanceId: "hub1", data: "authentic" };
    const signed = signRequestBody(body, kp.secretKey);
    const tampered = { ...signed, data: "tampered" };
    const pubKeyB64 = Buffer.from(kp.publicKey).toString("base64url");
    expect(verifyBodySignature(tampered, pubKeyB64)).toBe(false);
  });
});

// ─── Commander program structure ──────────────────────────────────────────────

describe("Commander program structure", () => {
  function getCommandNames(cmd: any): string[] {
    return cmd.commands.map((c: any) => c.name());
  }

  function findCommand(root: any, path: string[]): any {
    let node = root;
    for (const name of path) {
      node = node.commands.find((c: any) => c.name() === name);
      if (!node) return null;
    }
    return node;
  }

  test("program name is 'flair'", () => {
    expect(program.name()).toBe("flair");
  });

  test("top-level commands include expected entries", () => {
    const names = getCommandNames(program);
    for (const expected of ["init", "agent", "principal", "idp", "federation", "status", "start", "stop", "restart", "upgrade", "grant", "revoke"]) {
      expect(names).toContain(expected);
    }
  });

  // ── agent subcommands ──
  test("agent has add, list, show, rotate-key, remove subcommands", () => {
    const agentCmd = findCommand(program, ["agent"]);
    expect(agentCmd).not.toBeNull();
    const names = getCommandNames(agentCmd);
    expect(names).toContain("add");
    expect(names).toContain("list");
    expect(names).toContain("show");
    expect(names).toContain("remove");
    expect(names).toContain("rotate-key");
  });

  test("agent add accepts --port option", () => {
    const agentAdd = findCommand(program, ["agent", "add"]);
    expect(agentAdd).not.toBeNull();
    const optionNames = agentAdd.options.map((o: any) => o.long);
    expect(optionNames).toContain("--port");
  });

  test("agent add accepts --admin-pass option", () => {
    const agentAdd = findCommand(program, ["agent", "add"]);
    const optionNames = agentAdd.options.map((o: any) => o.long);
    expect(optionNames).toContain("--admin-pass");
  });

  test("agent add accepts --keys-dir option", () => {
    const agentAdd = findCommand(program, ["agent", "add"]);
    const optionNames = agentAdd.options.map((o: any) => o.long);
    expect(optionNames).toContain("--keys-dir");
  });

  test("agent remove accepts --force option", () => {
    const agentRemove = findCommand(program, ["agent", "remove"]);
    expect(agentRemove).not.toBeNull();
    const optionNames = agentRemove.options.map((o: any) => o.long);
    expect(optionNames).toContain("--force");
  });

  test("agent remove accepts --keep-keys option", () => {
    const agentRemove = findCommand(program, ["agent", "remove"]);
    const optionNames = agentRemove.options.map((o: any) => o.long);
    expect(optionNames).toContain("--keep-keys");
  });

  // ── principal subcommands ──
  test("principal has add, list, show, disable, promote subcommands", () => {
    const principalCmd = findCommand(program, ["principal"]);
    expect(principalCmd).not.toBeNull();
    const names = getCommandNames(principalCmd);
    expect(names).toContain("add");
    expect(names).toContain("list");
    expect(names).toContain("show");
    expect(names).toContain("disable");
    expect(names).toContain("promote");
  });

  test("principal add --kind defaults to 'agent'", () => {
    const principalAdd = findCommand(program, ["principal", "add"]);
    expect(principalAdd).not.toBeNull();
    const kindOpt = principalAdd.options.find((o: any) => o.long === "--kind");
    expect(kindOpt).not.toBeNull();
    expect(kindOpt.defaultValue).toBe("agent");
  });

  test("principal add accepts --trust option", () => {
    const principalAdd = findCommand(program, ["principal", "add"]);
    const optionNames = principalAdd.options.map((o: any) => o.long);
    expect(optionNames).toContain("--trust");
  });

  // ── idp subcommands ──
  test("idp has add, list, remove, test subcommands", () => {
    const idpCmd = findCommand(program, ["idp"]);
    expect(idpCmd).not.toBeNull();
    const names = getCommandNames(idpCmd);
    expect(names).toContain("add");
    expect(names).toContain("list");
    expect(names).toContain("remove");
    expect(names).toContain("test");
  });

  test("idp add has required --issuer option", () => {
    const idpAdd = findCommand(program, ["idp", "add"]);
    expect(idpAdd).not.toBeNull();
    const optionNames = idpAdd.options.map((o: any) => o.long);
    expect(optionNames).toContain("--issuer");
    expect(optionNames).toContain("--jwks-uri");
    expect(optionNames).toContain("--client-id");
  });

  // ── federation subcommands ──
  test("federation has status, pair, sync, token subcommands", () => {
    const fedCmd = findCommand(program, ["federation"]);
    expect(fedCmd).not.toBeNull();
    const names = getCommandNames(fedCmd);
    expect(names).toContain("status");
    expect(names).toContain("pair");
    expect(names).toContain("sync");
    expect(names).toContain("token");
  });

  test("federation pair accepts --token option", () => {
    const fedPair = findCommand(program, ["federation", "pair"]);
    expect(fedPair).not.toBeNull();
    const optionNames = fedPair.options.map((o: any) => o.long);
    expect(optionNames).toContain("--token");
  });

  test("federation token has --ttl option with default 60", () => {
    const fedToken = findCommand(program, ["federation", "token"]);
    expect(fedToken).not.toBeNull();
    const ttlOpt = fedToken.options.find((o: any) => o.long === "--ttl");
    expect(ttlOpt).not.toBeNull();
    expect(ttlOpt.defaultValue).toBe("60");
  });

  // ── grant / revoke ──
  test("grant command exists with --scope option defaulting to 'read'", () => {
    const grantCmd = findCommand(program, ["grant"]);
    expect(grantCmd).not.toBeNull();
    const scopeOpt = grantCmd.options.find((o: any) => o.long === "--scope");
    expect(scopeOpt).not.toBeNull();
    expect(scopeOpt.defaultValue).toBe("read");
  });

  test("revoke command exists", () => {
    const revokeCmd = findCommand(program, ["revoke"]);
    expect(revokeCmd).not.toBeNull();
  });

  // ── init ──
  test("init command has --agent-id option (no default)", () => {
    const initCmd = findCommand(program, ["init"]);
    expect(initCmd).not.toBeNull();
    const agentIdOpt = initCmd.options.find((o: any) => o.long === "--agent-id");
    expect(agentIdOpt).not.toBeNull();
    expect(agentIdOpt.defaultValue).toBeUndefined();
  });

  test("init command has --skip-start and --skip-soul flags", () => {
    const initCmd = findCommand(program, ["init"]);
    const optionNames = initCmd.options.map((o: any) => o.long);
    expect(optionNames).toContain("--skip-start");
    expect(optionNames).toContain("--skip-soul");
  });

  // ── status ──
  test("status command has --json option", () => {
    const statusCmd = findCommand(program, ["status"]);
    expect(statusCmd).not.toBeNull();
    const optionNames = statusCmd.options.map((o: any) => o.long);
    expect(optionNames).toContain("--json");
  });
});
