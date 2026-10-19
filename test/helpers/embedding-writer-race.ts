/**
 * embedding-writer-race.ts — shared real-Harper plumbing for the flair#2478
 * slice 3 embedding-writer suites (test/integration/*-lock-2478.test.ts).
 *
 * The composed component is a private copy of the built tree with two
 * test-only additions, the shapes slice 2 and flair#2656 already use:
 *  - the Memory write trace (test/fixtures/memory-write-trace-2478/probe.js),
 *    with the lock helper's callback wrapped so every traced `put`/`update`
 *    names the lock phase it ran under (`unattributed` outside any lock);
 *  - the armable Memory read failure (FAILING_MEMORY_READ_MODULE_SRC), so a
 *    case can make one post-commit verification read fail.
 * Nothing under resources/ or src/ changes or references either addition.
 *
 * Every instance is an ephemeral, home-isolated Harper this process started;
 * {@link assertOwnInstance} refuses any other target before the first call.
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { componentWithReplayProbe, type ProbeComponent } from "./component-with-replay-probe";
import { FAILING_MEMORY_READ_MODULE_REL, FAILING_MEMORY_READ_MODULE_SRC } from "./host-pointer-failing-component";
import type { HarperInstance } from "./harper-lifecycle";

export const TRACE_FILE = "memory-write-trace-2478.jsonl";

/** The incremental field set every server-computed re-embed writes. The HTTP
 *  re-embed also writes `instanceToken` on a legacy row that has none
 *  ({@link LEGACY_REEMBED_UPDATE_FIELDS}); the migration's fallback never does. */
export const EMBEDDING_UPDATE_FIELDS = ["embedding", "embeddedContentHash", "embeddingModel", "updatedAt"];
/** The HTTP re-embed's incremental field set on a legacy row with no `instanceToken`. */
export const LEGACY_REEMBED_UPDATE_FIELDS = [...EMBEDDING_UPDATE_FIELDS, "instanceToken"];

export interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array }
export const newAgent = (id: string): TestAgent => ({ id, ...nacl.sign.keyPair() });

/** The composed component (trace + lock attribution + armable read failure). */
export function composeTracedComponent(): ProbeComponent {
  const component = componentWithReplayProbe({ probe: {
    source: join("test", "fixtures", "memory-write-trace-2478", "probe.js"),
    target: join("dist", "resources", "zz-memory-write-trace-2478.js"),
    out: TRACE_FILE,
  } });
  const lockPath = join(component.dir, "dist", "resources", "memory-write-lock.js");
  const lockSource = readFileSync(lockPath, "utf8");
  const invocation = "value: await fn(scope)";
  expect(lockSource.split(invocation).length, "lock callback instrumentation site").toBe(2);
  writeFileSync(lockPath,
    'import { traceMemoryWriter } from "./zz-memory-write-trace-2478.js";\n' +
    lockSource.replace(invocation, "value: await traceMemoryWriter(options.phase, () => fn(scope))"));
  writeFileSync(join(component.dir, FAILING_MEMORY_READ_MODULE_REL), FAILING_MEMORY_READ_MODULE_SRC);
  return component;
}

export interface MemoryWriteTrace { writer: string; method: string; id: string; fields: string[] }

export class RaceHarness {
  harper!: HarperInstance;
  constructor(readonly pauseDir: string) {}

  get authHeader(): string {
    return "Basic " + Buffer.from(`${this.harper.admin.username}:${this.harper.admin.password}`).toString("base64");
  }

  assertOwnInstance(): void {
    for (const u of [new URL(this.harper.httpURL), new URL(this.harper.opsURL)]) {
      const port = Number(u.port);
      if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
        throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
      }
    }
    if (!this.harper.installDir.startsWith(tmpdir()) || !this.harper.process?.pid) {
      throw new Error("refusing to run: not an instance this test started");
    }
  }

  async ops(body: Record<string, unknown>): Promise<any> {
    const res = await fetch(this.harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.authHeader },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ops ${String(body.operation)} failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
    return text.length > 0 ? JSON.parse(text) : undefined;
  }

  async readRow(id: string): Promise<any> {
    const rows = await this.ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
    return Array.isArray(rows) ? rows[0] ?? null : rows;
  }

  /** A lock-bypassing incremental update through the operations API. */
  async rawUpdate(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.ops({ operation: "update", database: "flair", table: "Memory", records: [{ id, ...fields }] });
  }

  async seedAgent(agent: TestAgent, role = "agent"): Promise<void> {
    await this.ops({
      operation: "upsert", database: "flair", table: "Agent",
      records: [{ id: agent.id, name: agent.id, role, publicKey: Buffer.from(agent.publicKey).toString("base64"), createdAt: new Date().toISOString() }],
    });
  }

  /** Insert a Memory row with an explicit visibility, an incarnation token and
   *  a stamp the boot migrations leave alone (the seeding hygiene the build
   *  spec requires), overridden by `row`. */
  async seedMemory(row: Record<string, unknown>, defaults: Record<string, unknown>): Promise<void> {
    await this.ops({
      operation: "insert", database: "flair", table: "Memory",
      records: [{ visibility: "shared", durability: "standard", instanceToken: randomUUID(), createdAt: new Date().toISOString(), ...defaults, ...row }],
    });
  }

  signedHeader(agent: TestAgent, method: string, path: string): string {
    const ts = Date.now().toString();
    const nonce = randomUUID();
    const sig = nacl.sign.detached(new TextEncoder().encode(`${agent.id}:${ts}:${nonce}:${method}:${path}`), agent.secretKey);
    return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
  }

  signed(agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.harper.httpURL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: this.signedHeader(agent, method, path) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  }

  admin(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.harper.httpURL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: this.authHeader },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  }

  /** The server's own vector for `text`, through an ordinary admin PUT of a probe row. */
  async serverEmbedding(text: string): Promise<number[]> {
    const id = `ewr-probe-${randomUUID()}`;
    const res = await this.admin("PUT", `/Memory/${id}`, { id, agentId: "ewr-probe-agent", content: text, visibility: "private" });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = await this.readRow(id);
    expect(Array.isArray(row?.embedding) && row.embedding.length > 100, "the probe row has no server vector").toBe(true);
    return row.embedding;
  }

  // ── pause markers (resources/txn-pause-point.ts) ──
  clearMarkers(point: string): void {
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(this.pauseDir, `${marker}.${point}`), { force: true });
  }
  arm(point: string): void {
    this.clearMarkers(point);
    writeFileSync(join(this.pauseDir, `arm.${point}`), "");
  }
  async assertPaused(point: string, timeoutMs = 60_000): Promise<void> {
    expect(await waitForPath(join(this.pauseDir, `paused.${point}`), timeoutMs), `${point} was never paused`).toBe(true);
    expect(existsSync(join(this.pauseDir, `claimed.${point}`)), `${point} has no claimed marker`).toBe(true);
    // The claimant writes its paused marker and then removes the arm file.
    const deadline = Date.now() + 5_000;
    while (existsSync(join(this.pauseDir, `arm.${point}`)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(join(this.pauseDir, `arm.${point}`)), `${point} is still armed`).toBe(false);
  }
  /** Write `go` and require that the release, not the pause's time limit, ended it. */
  async release(point: string): Promise<void> {
    writeFileSync(join(this.pauseDir, `go.${point}`), "");
    const path = join(this.pauseDir, `released.${point}`);
    const deadline = Date.now() + 30_000;
    let text = "";
    while (Date.now() < deadline) {
      if (existsSync(path)) text = readFileSync(path, "utf8");
      if (text) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(text, `${point}: the pause ended by timeout, not by this test`).toBe("go");
  }
  /** Release without asserting (cleanup in a `finally`). */
  letGo(point: string): void {
    writeFileSync(join(this.pauseDir, `go.${point}`), "");
  }

  /** Harper's captured output and its log files: the server's own log lines. */
  serverLog(): string {
    let text = this.harper.getLog?.() ?? "";
    const dir = join(this.harper.installDir, "log");
    if (existsSync(dir)) for (const name of readdirSync(dir)) text += readFileSync(join(dir, name), "utf8");
    return text;
  }
  /** Poll until the server log contains `line`; returns whether it did. */
  async waitForLog(line: string, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.serverLog().includes(line)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.serverLog().includes(line);
  }
  /** Poll until a server log line matches `pattern`; returns whether one did. */
  async waitForLogMatch(pattern: RegExp, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(this.serverLog())) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return pattern.test(this.serverLog());
  }

  // ── the Memory write trace ──
  trace(id: string): MemoryWriteTrace[] {
    const path = join(this.harper.installDir, TRACE_FILE);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as MemoryWriteTrace).filter((entry) => entry.id === id);
  }
  writesBy(id: string, writer: string): MemoryWriteTrace[] {
    return this.trace(id).filter((entry) => entry.writer === writer);
  }
  /** Every traced write by `writer` on `id` is an incremental update of exactly `fields`. */
  expectIncrementalWrites(id: string, writer: string, fields: string[] = EMBEDDING_UPDATE_FIELDS): void {
    const writes = this.writesBy(id, writer);
    expect(writes.length, `no Memory write by ${writer} was traced for ${id}`).toBeGreaterThan(0);
    for (const entry of writes) {
      expect(entry.method, `${writer} wrote ${id} with ${entry.method}`).toBe("update");
      expect(entry.fields).toEqual([...fields].sort());
    }
  }
}

export async function waitForPath(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

/** A row with an empty owner holds the server's vector `own` stamped `model`,
 *  closer to `own` than to `other`. Its text hash is null: there is no owner
 *  to compute it with (resources/memory-embed-hash.ts). */
export function expectEmptyOwnerVector(row: any, model: string, own: number[], other: number[]): void {
  expect(row?.agentId).toBe("");
  expect(row?.embeddingModel).toBe(model);
  expect(row?.embeddedContentHash ?? null, "a vector for an empty owner carries no text hash").toBeNull();
  expect(Array.isArray(row?.embedding) && row.embedding.length > 100, "no server vector stored").toBe(true);
  const toOwn = cosine(row.embedding, own);
  expect(toOwn, "the stored vector is not the server's vector for the expected text").toBeGreaterThan(0.999);
  expect(toOwn, "the stored vector is closer to the old text's vector").toBeGreaterThan(cosine(row.embedding, other));
}

/** A 503 lock refusal with its named code; returns the parsed body. */
export async function expectRefused(res: Response, error: string): Promise<any> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(503);
  const body = JSON.parse(text);
  expect(body.error).toBe(error);
  return body;
}
