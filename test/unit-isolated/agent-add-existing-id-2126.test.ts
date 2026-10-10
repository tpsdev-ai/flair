/**
 * flair#2126 — `flair agent add` on an id that already exists must not print
 * `registered` while the stored public key stays unchanged.
 *
 * Isolated because it drives the process-global commander `program` and stands
 * up an HTTP server in place of the operations API. Harper 5.2.8 is simulated
 * here: an insert for an existing id returns OK and leaves the row alone.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { program } from "../../src/cli.js";

interface AgentRow {
  id: string;
  name: string;
  publicKey: string;
}

interface OpsBody {
  operation?: string;
  table?: string;
  search_value?: string;
  records?: Array<{ id?: string; name?: string; publicKey?: string }>;
}

let tmpHome: string;
let keysDir: string;
let server: Server;
let baseUrl: string;
let table: Map<string, AgentRow>;
let ops: string[];
/** When set, an insert returns OK but stores this public key instead of the one sent. */
let storePublicKey: string | null;
/** When set, an insert returns OK and stores nothing. */
let skipInsert: boolean;
/**
 * How Agent searches answer.
 * `table`: the stored row, or `[]` when that id is absent.
 * `empty-body`, `unreadable`, `malformed`, and `unexpected-id`: that response on every search.
 * `row-without-key`, `row-missing-name`, and `row-non-string-name`: `[]` on the first search, then the named row on the second.
 */
let searchMode:
  | "table"
  | "empty-body"
  | "unreadable"
  | "malformed"
  | "unexpected-id"
  | "row-without-key"
  | "row-missing-name"
  | "row-non-string-name";

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "flair-2126-"));
  keysDir = join(tmpHome, "keys");
  table = new Map();
  ops = [];
  storePublicKey = null;
  skipInsert = false;
  searchMode = "table";

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: OpsBody = {};
      try {
        body = JSON.parse(raw || "{}") as OpsBody;
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      if (body.operation === "search_by_value" && body.table === "Agent") {
        ops.push("search_by_value");
        const searched = String(body.search_value ?? "");
        if (searchMode === "empty-body") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("");
          return;
        }
        if (searchMode === "unreadable") {
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "64" });
          res.write("[");
          res.destroy();
          return;
        }
        if (searchMode === "malformed") {
          return json(res, 200, [{ name: "no-id" }]);
        }
        if (searchMode === "unexpected-id") {
          return json(res, 200, [{ id: "someone-else", name: "someone-else", publicKey: "other-key" }]);
        }
        if (searchMode === "row-without-key") {
          const priorSearches = ops.filter((op) => op === "search_by_value").length;
          if (priorSearches === 1) return json(res, 200, []);
          return json(res, 200, [{ id: searched, name: searched }]);
        }
        if (searchMode === "row-missing-name" || searchMode === "row-non-string-name") {
          const priorSearches = ops.filter((op) => op === "search_by_value").length;
          if (priorSearches === 1) return json(res, 200, []);
          const publicKey = table.get(searched)?.publicKey;
          const row =
            searchMode === "row-missing-name"
              ? { id: searched, publicKey }
              : { id: searched, publicKey, name: 12 };
          return json(res, 200, [row]);
        }
        const row = table.get(searched);
        return json(res, 200, row ? [row] : []);
      }
      if (body.operation === "insert" && body.table === "Agent") {
        ops.push("insert");
        const rec = body.records?.[0];
        if (!skipInsert && rec && typeof rec.id === "string" && typeof rec.publicKey === "string" && !table.has(rec.id)) {
          table.set(rec.id, {
            id: rec.id,
            name: typeof rec.name === "string" ? rec.name : rec.id,
            publicKey: storePublicKey ?? rec.publicKey,
          });
        }
        return json(res, 200, { ok: true });
      }
      if (body.operation === "sql") {
        // flair#2433 — the create path resolves the instance's own id from the
        // Instance table before it inserts the Agent row.
        ops.push("sql");
        return json(res, 200, [{ id: "inst-local-2126" }]);
      }
      ops.push(body.operation ?? "unknown");
      return json(res, 200, { ok: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock ops server has no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpHome, { recursive: true, force: true });
});

async function agentAdd(id: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  });
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  let code = 0;
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/^process\.exit\((\d+)\)$/);
    if (!match) throw err;
    code = Number(match[1]);
  } finally {
    process.exit = origExit;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function outputHasRegistered(stdout: string, stderr: string): boolean {
  return stdout.includes("registered") || stderr.includes("registered");
}

describe("flair#2126 — agent add does not claim a registration it did not store", () => {
  test("an existing id is refused, nothing is written, and the message names the remedy", async () => {
    const id = "taken-2126";
    table.set(id, { id, name: id, publicKey: "existing-public-key" });
    mkdirSync(keysDir, { recursive: true });
    const keyPath = join(keysDir, `${id}.key`);
    const prior = randomBytes(32);
    writeFileSync(keyPath, prior);

    const result = await agentAdd(id);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Agent '${id}'`);
    expect(result.stderr).toContain(`flair agent rotate-key ${id}`);
    expect(result.stderr).toContain(`flair agent remove ${id}`);
    expect(outputHasRegistered(result.stdout, result.stderr)).toBe(false);
    expect(ops).toEqual(["search_by_value"]);
    expect(table.get(id)?.publicKey).toBe("existing-public-key");
    expect(readFileSync(keyPath).equals(prior)).toBe(true);
    expect(existsSync(join(keysDir, `${id}.pub`))).toBe(false);
  });

  test("a new id registers only the public key the read-back returned", async () => {
    const id = "fresh-2126";
    const result = await agentAdd(id);

    expect(result.code).toBe(0);
    expect(ops).toEqual(["search_by_value", "sql", "insert", "search_by_value"]);
    const stored = table.get(id);
    expect(stored).toBeDefined();
    expect(result.stdout).toContain("registered");
    expect(result.stdout).toContain(`Public key:  ${stored!.publicKey}`);
    expect(existsSync(join(keysDir, `${id}.key`))).toBe(true);
    expect(readFileSync(join(keysDir, `${id}.key`)).length).toBe(32);
  });

  test("an insert that is skipped cannot produce a success message", async () => {
    const id = "skipped-2126";
    skipInsert = true;

    const result = await agentAdd(id);

    expect(result.code).toBe(1);
    expect(ops).toEqual(["search_by_value", "sql", "insert", "search_by_value"]);
    expect(table.has(id)).toBe(false);
    expect(result.stderr).toContain(`Agent '${id}'`);
    expect(result.stderr).toContain(`no Agent row for '${id}'`);
    expect(outputHasRegistered(result.stdout, result.stderr)).toBe(false);
  });

  test("an insert that stores a different public key cannot produce a success message", async () => {
    const id = "mismatch-2126";
    storePublicKey = "stored-public-key-not-the-one-written";

    const result = await agentAdd(id);

    expect(result.code).toBe(1);
    expect(ops).toEqual(["search_by_value", "sql", "insert", "search_by_value"]);
    expect(table.get(id)?.publicKey).toBe("stored-public-key-not-the-one-written");
    expect(result.stderr).toContain("stored-public-key-not-the-one-written");
    expect(result.stderr).toContain(`flair agent rotate-key ${id}`);
    expect(result.stderr).toContain(`flair agent remove ${id}`);
    expect(outputHasRegistered(result.stdout, result.stderr)).toBe(false);
    expect(result.stdout).not.toContain("stored-public-key-not-the-one-written");
    expect(result.stderr).toContain("generated or reused by this command");
  });

  test("a read-back row without a usable public key is not reported as a missing row", async () => {
    const id = "nokey-2126";
    searchMode = "row-without-key";

    const result = await agentAdd(id);

    expect(result.code).toBe(1);
    expect(ops).toEqual(["search_by_value", "sql", "insert", "search_by_value"]);
    expect(result.stderr).toContain(`Agent '${id}'`);
    expect(result.stderr).not.toContain(`no Agent row for '${id}'`);
    expect(result.stderr).toContain("usable public key");
    expect(outputHasRegistered(result.stdout, result.stderr)).toBe(false);
  });

  test("a read-back row with a matching public key and no name cannot print registered", async () => {
    const id = "noname-2126";
    searchMode = "row-missing-name";

    const result = await agentAdd(id);

    expect(result.code).toBe(1);
    expect(ops).toEqual(["search_by_value", "sql", "insert", "search_by_value"]);
    expect(result.stderr).toContain("name");
    expect(result.stderr).not.toContain("no Agent row");
    expect(outputHasRegistered(result.stdout, result.stderr)).toBe(false);
  });

  test("a read-back row with a matching public key and a non-string name cannot print registered", async () => {
    const id = "badname-2126";
    searchMode = "row-non-string-name";

    const result = await agentAdd(id);

    expect(result.code).toBe(1);
    expect(ops).toEqual(["search_by_value", "sql", "insert", "search_by_value"]);
    expect(result.stderr).toContain("name");
    expect(outputHasRegistered(result.stdout, result.stderr)).toBe(false);
  });
});

describe("flair#2126 — a failed lookup is not absence", () => {
  async function refusedBeforeWrite(id: string) {
    const result = await agentAdd(id);
    expect(result.code).toBe(1);
    expect(ops).toEqual(["search_by_value"]);
    expect(ops).not.toContain("insert");
    expect(existsSync(join(keysDir, `${id}.key`))).toBe(false);
    expect(existsSync(join(keysDir, `${id}.pub`))).toBe(false);
    expect(outputHasRegistered(result.stdout, result.stderr)).toBe(false);
    expect(result.stdout).not.toContain("Keypair written");
    expect(result.stdout).not.toContain("Reusing existing key");
    return result;
  }

  test("an empty search body is not absence", async () => {
    searchMode = "empty-body";
    const result = await refusedBeforeWrite("empty-body-2126");
    expect(result.stderr).toContain("empty body");
  });

  test("an unreadable search body is not absence", async () => {
    searchMode = "unreadable";
    const result = await refusedBeforeWrite("unreadable-2126");
    expect(result.stderr).toContain("could not read Agent 'unreadable-2126'");
  });

  test("malformed search rows are not absence", async () => {
    searchMode = "malformed";
    const result = await refusedBeforeWrite("malformed-2126");
    expect(result.stderr).toContain("malformed");
  });

  test("a search that returns a different id is not absence", async () => {
    searchMode = "unexpected-id";
    const result = await refusedBeforeWrite("unexpected-2126");
    expect(result.stderr).toContain("someone-else");
    expect(result.stderr).not.toContain("no Agent row");
  });
});
