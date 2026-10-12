/**
 * principal-add-home-2433.test.ts — flair#2433, flair#2473.
 *
 * `flair principal add` writes the Agent row through the operations API. The
 * HOME ASSIGNMENT on the `insert` is CREATE-ONLY: the resolved home rides on that
 * insert itself (so a row created at write time carries it, even one deleted
 * since the read). An existing row's insert is SKIPPED, so its stored home
 * stands; the write-back that follows writes back only an allow-list of the
 * row's other fields and omits the home field, and a differing non-null stored
 * home is refused. A stored `originatorInstanceId` is not changed by this
 * command, whatever appears between the read and the write.
 *
 * Isolated because it drives the process-global commander `program` and stands
 * up an HTTP server in place of the operations API.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../../src/cli.js";

let tmpHome: string;
let keysDir: string;
let server: Server;
let inserts: any[];
let updates: any[];
let storedRows: Array<Record<string, unknown>>;
/** Runs between the command's pre-read and its insert, so a test can commit a competing change in that gap. */
let onInsert: (() => void) | undefined;
/** When true, the mock resource answers the guarded write-back with `originator_instance_immutable` (409). */
let writeBackRefused = false;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "flair-2433-principal-"));
  keysDir = join(tmpHome, "keys");
  inserts = [];
  updates = [];
  storedRows = [];
  onInsert = undefined;
  writeBackRefused = false;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      // The write-back over an existing row goes to the Agent RESOURCE (a REST
      // PATCH to /Agent/:id), not the operations API — the resource runs it in an
      // owned transaction and may refuse it (flair#2473).
      if (req.method === "PATCH" && (req.url ?? "").startsWith("/Agent/")) {
        const record = JSON.parse(raw);
        updates.push({ records: [record] });
        const answer = writeBackRefused
          ? { error: "originator_instance_immutable", message: "the agent row's home is a peer's; refusing to change it" }
          : { writtenBack: true };
        res.writeHead(writeBackRefused ? 409 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer));
        return;
      }
      const body = JSON.parse(raw);
      let answer: unknown = { ok: true };
      if (body.operation === "sql") answer = [{ id: "inst-local-2433" }];
      else if (body.operation === "search_by_id") answer = storedRows;
      else if (body.operation === "insert") {
        inserts.push(body);
        onInsert?.();
        const record = body.records[0];
        const existing = storedRows.some((r) => r.id === record.id);
        if (existing) answer = { inserted_hashes: [], skipped_hashes: [record.id] };
        else {
          storedRows.push(record);
          answer = { inserted_hashes: [record.id], skipped_hashes: [] };
        }
      } else if (body.operation === "update") {
        updates.push(body);
        answer = { update_hashes: [body.records[0].id], skipped_hashes: [] };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpHome, { recursive: true, force: true });
});

async function principalAdd(id: string, opsPort: number): Promise<number> {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  let code = 0;
  try {
    await program.parseAsync([
      "node", "flair", "principal", "add", id,
      "--ops-port", String(opsPort),
      // The guarded write-back goes to the Agent RESOURCE on the HTTP port.
      "--port", String(opsPort),
      "--admin-pass", "throwaway-admin-pass-not-a-secret",
      "--keys-dir", keysDir,
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
  return code;
}

function opsPort(): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock ops server has no port");
  return address.port;
}

describe("flair#2433/#2473 — principal add is create-only", () => {
  test("a create (no stored row) inserts the local home", async () => {
    expect(await principalAdd("fresh-id", opsPort())).toBe(0);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].records[0].id).toBe("fresh-id");
    expect(inserts[0].records[0].originatorInstanceId).toBe("inst-local-2433");
    expect(updates).toHaveLength(0);
  });

  test("an existing row is written back without the home field", async () => {
    storedRows = [{ id: "known-id", originatorInstanceId: null }];
    expect(await principalAdd("known-id", opsPort())).toBe(0);
    // The INSERT carries the resolved home — it is create-only, so over an
    // existing row Harper skips it and the stored home stands.
    expect(inserts).toHaveLength(1);
    expect(inserts[0].records[0].originatorInstanceId).toBe("inst-local-2433");
    // The WRITE-BACK omits the home field, so the stored value is never changed.
    expect(updates).toHaveLength(1);
    expect(updates[0].records[0].id).toBe("known-id");
    expect("originatorInstanceId" in updates[0].records[0]).toBe(false);
  });

  test("a row deleted between the read and the write is re-created WITH the local home", async () => {
    // The pre-read found the row, so the old code (which stamped the home only
    // when the pre-read saw none) would insert a home-less row.
    storedRows = [{ id: "gone-id", originatorInstanceId: null }];
    onInsert = () => { storedRows = []; };
    expect(await principalAdd("gone-id", opsPort())).toBe(0);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].records[0].originatorInstanceId, "the re-created row carries no home").toBe("inst-local-2433");
    expect(updates).toHaveLength(0);
    expect(storedRows[0].originatorInstanceId).toBe("inst-local-2433");
  });

  test("a row that appears with a different home after the read is refused, never updated", async () => {
    // The pre-read saw no row, so the create proceeds; a row with a FOREIGN home
    // appears before the insert. Harper skips the create (create-only); the row
    // must be refused, not silently written back.
    onInsert = () => { storedRows = [{ id: "appeared-id", originatorInstanceId: "peer-inst" }]; };
    expect(await principalAdd("appeared-id", opsPort())).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(storedRows[0].originatorInstanceId, "the appeared row's home changed").toBe("peer-inst");
  });

  test("a differing non-null stored home is refused with the named error", async () => {
    storedRows = [{ id: "known-id", originatorInstanceId: "peer-inst" }];
    expect(await principalAdd("known-id", opsPort())).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test("a write-back the resource refuses as a foreign home fails by name", async () => {
    storedRows = [{ id: "known-id", originatorInstanceId: null }];
    // The resource's owned-transaction confirmation sees the home became a peer's
    // and aborts the staged write with `originator_instance_immutable`.
    writeBackRefused = true;
    expect(await principalAdd("known-id", opsPort())).toBe(1);
    expect(updates).toHaveLength(1);
    expect(storedRows[0].originatorInstanceId, "the row's home changed").toBeNull();
  });
});
