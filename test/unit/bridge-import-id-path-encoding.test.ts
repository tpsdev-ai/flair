/**
 * bridge-import-id-path-encoding.test.ts — flair#1970 item 5.
 *
 * `flair bridge import` builds and SIGNS its own `PUT /Memory/<id>` path
 * (src/commands/bridge.ts). Since #1969 flair-client percent-encodes ids; this
 * command must do the same, and — critically — the Ed25519 signature must
 * cover the SAME path that is sent. A real Ed25519 keypair and a real
 * signature check prove it: the mock daemon verifies the request's
 * Authorization header over the path it actually received.
 *
 * Spawns the built CLI (like test/unit/orgevent-cli.test.ts), HOME-isolated to
 * a scratch dir so nothing touches a real ~/.flair. On origin/main the path is
 * encoded for the fetch but the signature is computed over the RAW id, so the
 * verification fails and the CLI exits non-zero — the test is RED there.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CHILD_DEADLINE_MS = 20_000;

const AGENT = "bridge-agent";
// Every reserved URL character in one id: `#`, `?`, `/`, `%` and a space.
const RAW_ID = "rec#1?x/y%z w";
const BRIDGE_NAME = "paths-bridge";

const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");

interface Observed {
  path: string;
  body: string;
  signatureOk: boolean;
}

function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, FLAIR_AGENT_ID: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000, // literal so the spawn-budget gate sees a deadline (flair#1807)
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(
          new Error(
            childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, {
              status: code,
              signal,
              elapsedMs: Date.now() - startedAt,
              stdout,
              stderr,
            }),
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

describe("flair bridge import: the signed Memory path equals the sent path (#1970)", () => {
  let scratch: string;
  let dir: string;
  let keyPath: string;
  let publicKey: Uint8Array;
  let server: Server;
  let mockUrl: string;
  const observed: Observed[] = [];

  beforeAll(async () => {
    ensureCliBuild();

    scratch = mkdtempSync(join(tmpdir(), "flair-bridge-1970-home-"));
    dir = mkdtempSync(join(tmpdir(), "flair-bridge-1970-work-"));

    // A real Ed25519 key: 32-byte seed in a file, public key for verification.
    const kp = nacl.sign.keyPair();
    publicKey = kp.publicKey;
    keyPath = join(scratch, `${AGENT}.key`);
    writeFileSync(keyPath, Buffer.from(kp.secretKey.slice(0, 32)));

    mkdirSync(join(dir, ".flair-bridge"), { recursive: true });
    writeFileSync(
      join(dir, ".flair-bridge", `${BRIDGE_NAME}.yaml`),
      [
        `name: ${BRIDGE_NAME}`,
        "version: 1",
        "kind: file",
        "import:",
        "  sources:",
        "    - path: records.jsonl",
        "      format: jsonl",
        "      map:",
        '        content: "$.text"',
        '        id: "$.id"',
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "records.jsonl"), JSON.stringify({ id: RAW_ID, text: "hello there" }) + "\n");

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = req.url ?? "";
        if (req.method === "PUT" && url.startsWith("/Memory/")) {
          const auth = String(req.headers["authorization"] ?? "");
          const m = /^TPS-Ed25519 ([^:]+):(\d+):([^:]+):(.+)$/.exec(auth);
          let ok = false;
          if (m) {
            const [, agent, ts, nonce, sigB64] = m;
            const payload = Buffer.from(`${agent}:${ts}:${nonce}:PUT:${url}`, "utf-8");
            ok = nacl.sign.detached.verify(payload, Buffer.from(sigB64, "base64"), publicKey);
          }
          observed.push({ path: url, body, signatureOk: ok });
          if (ok) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ id: RAW_ID }));
          } else {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("bad signature");
          }
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("nope");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("mock server did not bind");
    mockUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("an id with reserved URL characters is sent as ONE encoded segment, signed as sent", async () => {
    const res = await runCli(
      ["bridge", "import", BRIDGE_NAME, "--agent", AGENT, "--cwd", dir, "--url", mockUrl, "--key", keyPath],
      { HOME: scratch },
      dir,
    );

    // The mock observed the request and checked the signature over the path it
    // RECEIVED. On origin/main the signature covers the raw id while the path is
    // sent encoded, so signatureOk is false (and the CLI exits non-zero); on the
    // fix both agree.
    expect(observed).toHaveLength(1);

    const [seen] = observed;
    // Signed path == sent path (the mock verified the signature over the
    // received path with a real public key).
    expect(seen.signatureOk).toBe(true);

    const parts = seen.path.split("/").filter(Boolean);
    expect(parts.length).toBe(2); // assertion: /Memory/<one segment>
    expect(parts[0]).toBe("Memory");
    expect(seen.path).not.toContain("?");
    expect(seen.path).not.toContain("#");
    expect(decodeURIComponent(parts[1])).toBe(RAW_ID);
    expect(seen.path).toBe(`/Memory/${encodeURIComponent(RAW_ID)}`);
    expect(JSON.parse(seen.body).id).toBe(RAW_ID);

    expect(res.code).toBe(0);
  }, 25_000); // per-case budget > the child deadline (flair#1807)

  it("a '.'/'..' record id is refused with ZERO requests to the daemon", async () => {
    for (const bad of [".", ".."]) {
      const before = observed.length;
      writeFileSync(join(dir, "records.jsonl"), JSON.stringify({ id: bad, text: "hello there" }) + "\n");
      const res = await runCli(
        ["bridge", "import", BRIDGE_NAME, "--agent", AGENT, "--cwd", dir, "--url", mockUrl, "--key", keyPath],
        { HOME: scratch },
        dir,
      );
      expect(observed.length).toBe(before); // assertion: the daemon received NOTHING for a dot-segment id
      expect(res.code).not.toBe(0); // assertion: the import refused the id
    }
  }, 25_000);
});
