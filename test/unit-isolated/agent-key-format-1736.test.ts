/**
 * agent-key-format-1736.test.ts — flair#1736
 *
 * The whole first-run path, end to end: `flair agent add` writes a RAW 32-byte
 * Ed25519 seed to ~/.flair/keys/<agent>.key, and `scripts/flair-client.mjs` must
 * make an authenticated request with that key — unmoved and unconverted. No
 * manual DER prefix, no hand-written PKCS8.
 *
 * Isolated because it drives the real commander `program` (process-global) and
 * starts an HTTP server that stands in for both the ops-API insert and the
 * authenticated read.
 *
 * SECURITY: every key here is generated in-test (or by `agent add` into a
 * throwaway tmp HOME). No real key from ~/.flair/keys is read, and no key bytes
 * are printed, logged, or asserted — only lengths, paths and formats.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  createPublicKey,
  verify as cryptoVerify,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { program } from "../../src/cli.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLIENT = join(REPO_ROOT, "scripts", "flair-client.mjs");

// SPKI prefix for an Ed25519 public key (RFC 8410), so the raw 32-byte public key
// `agent add` registers can verify the client's signature.
const SPKI_PUB_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519Verify(pubRaw: Buffer, message: Buffer, sig: Buffer): boolean {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_PUB_PREFIX, pubRaw]),
    format: "der",
    type: "spki",
  });
  return cryptoVerify(null, message, key, sig);
}

let tmpHome: string;
let keysDir: string;
let server: Server;
let baseUrl: string;
let registeredPubKey: Buffer | null;
let readAuthHeader: string | null;
let readPath: string | null;

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "flair-1736-"));
  keysDir = join(tmpHome, ".flair", "keys");
  registeredPubKey = null;
  readAuthHeader = null;
  readPath = null;

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST") {
        // `flair agent add` seeds the Agent via the ops API — capture the public
        // key it registered so we can verify the client's signature later.
        try {
          const payload = JSON.parse(body || "{}");
          const pub = payload?.records?.[0]?.publicKey;
          if (typeof pub === "string") registeredPubKey = Buffer.from(pub, "base64url");
        } catch {
          /* not the insert we care about */
        }
        return json(res, 200, { ok: true });
      }
      // The authenticated read from the client.
      readPath = req.url ?? null;
      readAuthHeader = (req.headers["authorization"] as string | undefined) ?? null;
      return json(res, 200, { results: [] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Run the real `flair agent add` against the mock ops API, writing keys to `keysDir`.
 *  stdout is silenced so the printed PUBLIC key never lands in CI logs (the task's
 *  no-key-values rule); errors still surface on stderr. */
async function agentAdd(id: string): Promise<void> {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await program.parseAsync([
      "node",
      "flair",
      "agent",
      "add",
      id,
      "--ops-target",
      baseUrl,
      "--admin-pass",
      "throwaway-admin-pass-not-a-secret",
      "--keys-dir",
      keysDir,
    ]);
  } finally {
    logSpy.mockRestore();
  }
}

/** Run scripts/flair-client.mjs as `agentId` with a throwaway HOME.
 *  Async spawn (not spawnSync): the mock server lives in THIS process, so a
 *  synchronous spawn would block the event loop and deadlock the request. */
function runClient(agentId: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLIENT, ...args], {
      env: {
        ...process.env,
        HOME: tmpHome,
        FLAIR_URL: baseUrl,
        FLAIR_AGENT_ID: agentId,
        FLAIR_PRIV_KEY: "",
        FLAIR_KEY_DIR: "",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function parseAuthHeader(header: string) {
  const [schemeAgent, ts, nonce, sig] = header.split(":");
  return { agentId: schemeAgent.replace(/^TPS-Ed25519 /, ""), ts, nonce, sig };
}

describe("flair#1736 — agent add key format is loadable by flair-client.mjs with no conversion", () => {
  test("ACCEPTANCE 1+2: agent add, then an authenticated read as that agent", async () => {
    const id = "gauge";
    await agentAdd(id);

    // `agent add` wrote a bare 32-byte seed — the exact shape the client used to reject.
    const keyPath = join(keysDir, `${id}.key`);
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath).length).toBe(32);

    // The client reads it with no conversion and makes the read.
    const r = await runClient(id, ["memory", "list"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);

    // …and the read was authenticated AS gauge: the TPS-Ed25519 signature the
    // client produced verifies against the public key `agent add` registered.
    expect(readPath).toBe(`/Memory/?agentId=${id}`);
    expect(readAuthHeader).not.toBeNull();
    const auth = parseAuthHeader(readAuthHeader!);
    expect(auth.agentId).toBe(id);
    expect(ed25519Verify(
      registeredPubKey!,
      Buffer.from(`${auth.agentId}:${auth.ts}:${auth.nonce}:GET:${readPath}`),
      Buffer.from(auth.sig, "base64"),
    )).toBe(true);
  });

  test("ACCEPTANCE 3: a wrong-shape key names the ENCODING problem, not an auth failure", async () => {
    const id = "broken";
    mkdirSync(keysDir, { recursive: true });
    // 7 random bytes: neither a 32-byte seed nor a valid PKCS8 DER.
    writeFileSync(join(keysDir, `${id}.key`), randomBytes(7));

    const r = await runClient(id, ["memory", "list"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ENCODING problem/i);
    expect(r.stderr).toMatch(/not a recognised Ed25519 key/i);
    expect(r.stderr).toContain(join(keysDir, `${id}.key`));
    // It never reaches the server, so it can never be mistaken for a 401.
    expect(registeredPubKey).toBeNull();
    expect(readAuthHeader).toBeNull();
    expect(readPath).toBeNull();
  });

  test("REGRESSION GUARD: an existing base64 PKCS8 key at the legacy path still works", async () => {
    const id = "legacy";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const legacyDir = join(tmpHome, ".tps", "secrets", "flair");
    mkdirSync(legacyDir, { recursive: true });
    // base64-encoded PKCS8 DER — the shape the client required before this change.
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    writeFileSync(join(legacyDir, `${id}-priv.key`), Buffer.from(der).toString("base64"));
    const pubRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);

    const r = await runClient(id, ["memory", "list"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);

    expect(readPath).toBe(`/Memory/?agentId=${id}`);
    const auth = parseAuthHeader(readAuthHeader!);
    expect(ed25519Verify(
      pubRaw,
      Buffer.from(`${auth.agentId}:${auth.ts}:${auth.nonce}:GET:${readPath}`),
      Buffer.from(auth.sig, "base64"),
    )).toBe(true);
  });
});
