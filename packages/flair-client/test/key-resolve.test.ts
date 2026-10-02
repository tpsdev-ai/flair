import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const { FlairClient, FlairError } = await import("../src/client.js");
const {
  callTimeHomes,
  expandHomePrefix,
  formatKeyLookup,
  inspectKeyLookup,
  keyPathCandidates,
  loadPrivateKey,
  loadPrivateKeyString,
  resolveKeyPath,
  signRequest,
} = await import("../src/auth.js");

/** True when `header` carries an agent signature over `${agentId}:${ts}:${nonce}:${method}:${path}`. */
function verifySignedHeader(header: string, publicKey: ReturnType<typeof createPublicKey>, method: string, path: string): boolean {
  const rest = header.replace(/^TPS-Ed25519 /, "");
  const cut = rest.indexOf(":");
  const agentId = rest.slice(0, cut);
  const [ts, nonce, signature] = rest.slice(cut + 1).split(":");
  return verify(null, Buffer.from(`${agentId}:${ts}:${nonce}:${method}:${path}`), publicKey, Buffer.from(signature, "base64"));
}

function uniqueId(label: string): string {
  return `flair-1271-${label}-${randomBytes(4).toString("hex")}`;
}

describe("key path resolution (flair#1271)", () => {
  const savedKeyDir = process.env.FLAIR_KEY_DIR;
  const savedKeyPath = process.env.FLAIR_KEY_PATH;
  let trash: string[] = [];

  beforeEach(() => {
    delete process.env.FLAIR_KEY_DIR;
    delete process.env.FLAIR_KEY_PATH;
    trash = [];
  });

  afterEach(() => {
    if (savedKeyDir === undefined) delete process.env.FLAIR_KEY_DIR;
    else process.env.FLAIR_KEY_DIR = savedKeyDir;
    if (savedKeyPath === undefined) delete process.env.FLAIR_KEY_PATH;
    else process.env.FLAIR_KEY_PATH = savedKeyPath;
    for (const p of trash) rmSync(p, { recursive: true, force: true });
  });

  test("expandHomePrefix uses the provided home, not cwd", () => {
    expect(expandHomePrefix("~/.flair/keys/x.key", "/home/agent")).toBe(
      "/home/agent/.flair/keys/x.key",
    );
    expect(expandHomePrefix("~", "/home/agent")).toBe("/home/agent");
    expect(expandHomePrefix("/abs/x.key", "/home/agent")).toBe("/abs/x.key");
  });

  test("FLAIR_KEY_DIR=~/... resolves via os.homedir at call time, not cwd", () => {
    const agentId = uniqueId("tilde");
    const rel = `.flair-1271-tilde-${randomBytes(4).toString("hex")}`;
    const homeDir = join(homedir(), rel);
    mkdirSync(homeDir, { recursive: true });
    trash.push(homeDir);
    const homeKey = join(homeDir, `${agentId}.key`);
    writeFileSync(homeKey, randomBytes(32));

    const cwdRoot = mkdtempSync(join(tmpdir(), "flair-1271-cwd-"));
    trash.push(cwdRoot);
    const decoyDir = join(cwdRoot, "~", rel);
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(join(decoyDir, `${agentId}.key`), Buffer.from("decoy-not-the-home-key"));

    const savedCwd = process.cwd();
    try {
      process.chdir(cwdRoot);
      process.env.FLAIR_KEY_DIR = `~/${rel}`;
      const found = resolveKeyPath(agentId);
      expect(found).toBe(homeKey);
      expect(found).not.toContain(cwdRoot);
    } finally {
      process.chdir(savedCwd);
    }
  });

  test("keyPathCandidates for auto-resolve are absolute (never cwd-relative ~)", () => {
    const agentId = uniqueId("abs");
    const candidates = keyPathCandidates(agentId);
    expect(candidates.length).toBeGreaterThan(0);
    for (const p of candidates) {
      expect(p.startsWith("/")).toBe(true);
      expect(p.includes("/~/") || p.startsWith("~/")).toBe(false);
    }
    expect(candidates.some((p) => p.endsWith(`/.flair/keys/${agentId}.key`))).toBe(true);
  });

  test("callTimeHomes merges passwd home when it diverges from os.homedir / $HOME", () => {
    // Sanitized-MCP-HOME fixture: sandbox is what os.homedir()/$HOME would
    // report; the key lives on the account home. Dropping the userHomedir
    // probe makes before/after this fix look the same — so this must fail
    // if that probe is removed.
    expect(callTimeHomes({
      homedir: "/var/mcp/sandbox",
      envHome: "/var/mcp/sandbox",
      userHomedir: "/home/agent",
    })).toEqual(["/var/mcp/sandbox", "/home/agent"]);
  });

  test("resolveKeyPath finds a key only on the passwd home, not the MCP sandbox home", () => {
    const agentId = uniqueId("althome");
    const sandbox = mkdtempSync(join(tmpdir(), "flair-1271-sandbox-"));
    const account = mkdtempSync(join(tmpdir(), "flair-1271-account-"));
    trash.push(sandbox, account);
    mkdirSync(join(account, ".flair", "keys"), { recursive: true });
    const accountKey = join(account, ".flair", "keys", `${agentId}.key`);
    writeFileSync(accountKey, randomBytes(32));
    const found = resolveKeyPath(agentId, undefined, [sandbox, account]);
    expect(found).toBe(accountKey);
    expect(resolveKeyPath(agentId, undefined, [sandbox])).toBeNull();
  });

  test("$HOME is probed even when os.homedir() is a different path (Bun caches homedir)", () => {
    const agentId = uniqueId("envhome");
    const envHome = mkdtempSync(join(tmpdir(), "flair-1271-envhome-"));
    trash.push(envHome);
    mkdirSync(join(envHome, ".flair", "keys"), { recursive: true });
    const envKey = join(envHome, ".flair", "keys", `${agentId}.key`);
    writeFileSync(envKey, randomBytes(32));
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = envHome;
      expect(callTimeHomes()).toContain(envHome);
      expect(resolveKeyPath(agentId)).toBe(envKey);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  test("inspectKeyLookup names every candidate and whether it exists", () => {
    const agentId = uniqueId("inspect");
    const dir = mkdtempSync(join(tmpdir(), "flair-1271-inspect-"));
    trash.push(dir);
    process.env.FLAIR_KEY_DIR = dir;
    const snapshot = inspectKeyLookup(agentId);
    expect(snapshot.agentId).toBe(agentId);
    expect(snapshot.resolvedPath).toBeNull();
    expect(snapshot.candidates.some((c) => c.path === join(dir, `${agentId}.key`) && !c.exists)).toBe(true);
    expect(snapshot.home).toBeTruthy();
  });
});

describe("missed freshly-created key (flair#1271)", () => {
  const originalFetch = globalThis.fetch;
  const savedKeyDir = process.env.FLAIR_KEY_DIR;
  let mockFetch: ReturnType<typeof mock>;
  let dir: string;

  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = mockFetch as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "flair-1271-fresh-"));
    process.env.FLAIR_KEY_DIR = dir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedKeyDir === undefined) delete process.env.FLAIR_KEY_DIR;
    else process.env.FLAIR_KEY_DIR = savedKeyDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("explicit Basic mode bypasses local and in-memory signing keys", async () => {
    const agentId = uniqueId("basic-only");
    writeFileSync(join(dir, `${agentId}.key`), randomBytes(32));
    const client = new FlairClient({
      agentId, authMode: "basic", adminUser: "admin", adminPassword: "legacy-secret",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    });
    await client.health();
    expect((mockFetch as any).mock.calls[0][1].headers.Authorization).toBe(
      "Basic " + Buffer.from("admin:legacy-secret").toString("base64"),
    );
    writeFileSync(join(dir, `${agentId}.key`), "malformed-key");
    const malformed = new FlairClient({ agentId, authMode: "basic", adminUser: "admin", adminPassword: "legacy-secret" });
    await malformed.health();
    expect((mockFetch as any).mock.calls[1][1].headers.Authorization).toStartWith("Basic ");
  });

  test("a key written after the first miss is picked up on the next request", async () => {
    const agentId = uniqueId("fresh");
    const client = new FlairClient({ agentId });

    await client.health();
    const firstHeaders = (mockFetch as any).mock.calls[0][1].headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBeUndefined();

    writeFileSync(join(dir, `${agentId}.key`), randomBytes(32));

    await client.health();
    const secondHeaders = (mockFetch as any).mock.calls[1][1].headers as Record<string, string>;
    expect(secondHeaders.Authorization).toStartWith("TPS-Ed25519 ");
    expect(secondHeaders.Authorization).toContain(agentId);
  });

  test("401 attaches the paths that were looked in", async () => {
    const agentId = uniqueId("401");
    mockFetch = mock(() => Promise.resolve(new Response("unauthorized", { status: 401 })));
    globalThis.fetch = mockFetch as typeof fetch;

    const client = new FlairClient({ agentId });
    let caught: unknown;
    try {
      await client.health();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FlairError);
    const err = caught as InstanceType<typeof FlairError>;
    expect(err.status).toBe(401);
    expect(err.keyLookup).toBeDefined();
    expect(err.keyLookup!.agentId).toBe(agentId);
    expect(err.keyLookup!.signed).toBe(false);
    expect(err.keyLookup!.authMethod).toBe("none");
    expect(err.keyLookup!.candidates.some((c) => c.path.endsWith(`${agentId}.key`))).toBe(true);
  });

  test("401 after Basic auth does not push FLAIR_KEY_PATH", async () => {
    const agentId = uniqueId("basic");
    mockFetch = mock(() => Promise.resolve(new Response("unauthorized", { status: 401 })));
    globalThis.fetch = mockFetch as typeof fetch;

    const client = new FlairClient({
      agentId,
      adminUser: "admin",
      adminPassword: "s3cret",
    });
    let caught: unknown;
    try {
      await client.health();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FlairError);
    const err = caught as InstanceType<typeof FlairError>;
    expect(err.keyLookup!.authMethod).toBe("basic");
    expect(err.keyLookup!.signed).toBe(false);
    expect(err.keyLookup!.candidates).toEqual([]);
    expect(err.keyLookup!.home).toBe("");
    expect(err.keyLookup!.resolvedPath).toBeNull();
    const text = formatKeyLookup(err.keyLookup!);
    expect(text).toContain("Basic admin credentials");
    expect(text).toContain("FLAIR_ADMIN_PASSWORD");
    expect(text).not.toContain("Looked for a key at");
    expect(text).not.toContain(".key");
    expect(text).not.toContain("FLAIR_KEY_PATH");
    expect(text).not.toContain("os.homedir()");
  });
});

describe("formatKeyLookup (flair#1271)", () => {
  test("unsigned 401 names actor, missing paths, and the FLAIR_KEY_PATH remedy", () => {
    const text = formatKeyLookup({
      agentId: "grok-cos",
      home: "/home/agent",
      candidates: [
        { path: "/home/agent/.flair/keys/grok-cos.key", exists: false },
        { path: "/home/agent/.tps/secrets/flair/grok-cos-priv.key", exists: false },
      ],
      resolvedPath: null,
      signed: false,
    });
    expect(text).toContain("agent 'grok-cos'");
    expect(text).toContain("without a signing key");
    expect(text).toContain("/home/agent/.flair/keys/grok-cos.key (missing)");
    expect(text).toContain("os.homedir() at lookup: /home/agent");
    expect(text).toContain("FLAIR_KEY_PATH");
  });

  test("basic-auth 401 names admin credentials, not FLAIR_KEY_PATH", () => {
    const text = formatKeyLookup({
      agentId: "grok-cos",
      home: "/home/agent",
      candidates: [{ path: "/home/agent/.flair/keys/grok-cos.key", exists: false }],
      resolvedPath: null,
      signed: false,
      authMethod: "basic",
    });
    expect(text).toContain("agent 'grok-cos'");
    expect(text).toContain("Basic admin credentials");
    expect(text).toContain("FLAIR_ADMIN_USER");
    expect(text).toContain("FLAIR_ADMIN_PASSWORD");
    expect(text).not.toContain("Looked for a key at");
    expect(text).not.toContain(".key");
    expect(text).not.toContain("FLAIR_KEY_PATH");
    expect(text).not.toContain("os.homedir()");
    expect(text).not.toContain("without a signing key");
  });

  test("signed 401 names the path that was used", () => {
    const text = formatKeyLookup({
      agentId: "grok-cos",
      home: "/home/agent",
      candidates: [{ path: "/home/agent/.flair/keys/grok-cos.key", exists: true }],
      resolvedPath: "/home/agent/.flair/keys/grok-cos.key",
      signed: true,
    });
    expect(text).toContain("signed with /home/agent/.flair/keys/grok-cos.key");
    expect(text).toContain("(found)");
    expect(text).toContain("flair agent add");
  });
});

describe("loadPrivateKeyString — a key held as text (flair#1942)", () => {
  test("decodes a base64 PKCS8 DER key and signs with it", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const text = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");

    const header = signRequest("agent-text", loadPrivateKeyString(text), "GET", "/Memory");

    expect(verifySignedHeader(header, publicKey, "GET", "/Memory")).toBe(true);
  });

  test("decodes a base64 raw 32-byte seed", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const seedText = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer)
      .subarray(-32)
      .toString("base64");

    const header = signRequest("agent-seed", loadPrivateKeyString(seedText), "POST", "/Memory/x");

    expect(verifySignedHeader(header, publicKey, "POST", "/Memory/x")).toBe(true);
  });

  test("resolves the same key as loadPrivateKey over a file with the same contents", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const text = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
    const dir = mkdtempSync(join(tmpdir(), "flair-1942-keytext-"));
    try {
      const file = join(dir, "agent.key");
      writeFileSync(file, text);
      const fromFile = createPublicKey(loadPrivateKey(file));
      const fromText = createPublicKey(loadPrivateKeyString(text));
      expect(fromText.export({ type: "spki", format: "pem" })).toBe(fromFile.export({ type: "spki", format: "pem" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a PEM — key files are not PEM", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const keyText = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");

    // The valid encoding resolves, so this test cannot pass on a tree where
    // `loadPrivateKeyString` is missing — only the PEM case throws.
    expect(() => loadPrivateKeyString(keyText)).not.toThrow();
    expect(() => loadPrivateKeyString(pem)).toThrow();
  });
});
