import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

import { verifyAuditLog } from "../../src/cli.ts";

/**
 * flair#970 — audit-log positive control.
 *
 * `flair doctor` / `flair init` must verify the Harper audit log ACTUALLY
 * records — by writing probe rows and reading their audit entries back —
 * never by trusting the `audit: true` flag. A node that joined or resynced
 * via cluster base copy reports audit enabled and answers read_audit_log
 * with clean empty (harper#2212): before this check, that state passed
 * silently (the canonical check that cannot fire).
 *
 * verifyAuditLog() drives the gate. We mock global.fetch to simulate each
 * server state (same shape as the sibling doctor-embed-verify.test.ts):
 *   - entries present:   both probe writes come back as audit entries → "ok"
 *   - empty array:       {"<id>": []} — enabled but NOT recording → "degraded"
 *                        ★ the positive-control row: the pre-fix world
 *                          silently passed this state as ok
 *   - HTTP 400:          audit disabled in the root harperdb-config.yaml
 *                        → "degraded" with the enable remedy cause
 *   - ops unreachable:   → "skipped" (rendered UNVERIFIED by both callers —
 *                          an unrun check must not look like a pass)
 *
 * A real Ed25519 key is written to disk so the signing path runs exactly as
 * in production; only the network is mocked.
 */

const AGENT_ID = "doctor-audit-test-agent";
const BASE_URL = "http://127.0.0.1:19926";
const OPS_URL = "http://127.0.0.1:19925";
const ADMIN_USER = "admin";
const ADMIN_PASS = "test-admin-pass";
let keysDir: string;
const realFetch = globalThis.fetch;

beforeAll(() => {
  keysDir = mkdtempSync(join(tmpdir(), "flair-doctor-audit-keys-"));
  // Real 32-byte Ed25519 seed so buildEd25519Auth() can sign the probe writes.
  const kp = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${AGENT_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
});

afterAll(() => {
  rmSync(keysDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call { method: string; url: string; body?: unknown }

/**
 * Install a fetch mock simulating the flair REST surface (PUT/PATCH/DELETE
 * /Memory/<id> on BASE_URL) plus the Harper ops API (POST on OPS_URL).
 *
 * `auditEntriesFor(id)` builds the read_audit_log response body for the probe
 * id captured from the PUT; `auditStatus` overrides the ops HTTP status;
 * `opsThrows` makes the ops fetch reject (unreachable).
 */
function mockServer(opts: {
  auditEntriesFor?: (id: string) => unknown[];
  auditStatus?: number;
  auditBody?: unknown;
  opsThrows?: boolean;
  patchStatus?: number;
  putStatus?: number;
}): Call[] {
  const calls: Call[] = [];
  let probeId = "";
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
    calls.push({ method, url, body });

    if (url.startsWith(OPS_URL)) {
      if (opts.opsThrows) throw new Error("connect ECONNREFUSED 127.0.0.1:19925");
      if (opts.auditStatus && opts.auditStatus !== 200) {
        return jsonResponse(opts.auditStatus, opts.auditBody ?? { error: "To use this operation audit log must be enabled in harperdb-config.yaml" });
      }
      return jsonResponse(200, { [probeId]: opts.auditEntriesFor ? opts.auditEntriesFor(probeId) : [] });
    }
    if (method === "PUT") {
      probeId = url.split("/Memory/")[1] ?? "";
      return jsonResponse(opts.putStatus ?? 200, { id: probeId });
    }
    if (method === "PATCH") {
      return new Response(null, { status: opts.patchStatus ?? 204 });
    }
    if (method === "DELETE") return jsonResponse(200, { ok: true });
    return jsonResponse(404, { error: "unexpected" });
  }) as typeof fetch;
  return calls;
}

// A distinctive marker planted inside mocked audit-entry record images. If it
// ever shows up in a result, the check leaked audit-entry content — which
// doctor/init would then print (Sherlock's binding requirement: assertions on
// audit entries are BOOLEAN; entry content must never reach the output).
const RECORD_CONTENT_MARKER = "SECRET-AUDIT-RECORD-CONTENT-must-never-leak";

function entryFor(id: string, operation: string) {
  return {
    operation,
    timestamp: Date.now(),
    user_name: "admin",
    ids: [id],
    records: [{ id, content: RECORD_CONTENT_MARKER }],
  };
}

describe("verifyAuditLog (flair#970: audit-log positive control)", () => {
  it("returns 'ok' when both probe writes come back as audit entries", async () => {
    // Live-verified harper@5.2.0 shape: PUT → "upsert", PATCH → "patch".
    const calls = mockServer({ auditEntriesFor: (id) => [entryFor(id, "upsert"), entryFor(id, "patch")] });

    const result = await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    expect(result.state).toBe("ok");

    // The probe really did write → write → read-audit → delete.
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/Memory/"))).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/Memory/"))).toBe(true);
    const opsCall = calls.find((c) => c.url.startsWith(OPS_URL));
    expect(opsCall).toBeDefined();
    expect((opsCall!.body as any)?.operation).toBe("read_audit_log");
    expect((opsCall!.body as any)?.search_type).toBe("hash_value");
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/Memory/"))).toBe(true);

    // Probe hygiene: ephemeral durability + namespaced probe id.
    const putCall = calls.find((c) => c.method === "PUT")!;
    expect((putCall.body as any)?.durability).toBe("ephemeral");
    expect(putCall.url).toContain("/Memory/flair-doctor-audit-probe-");

    // Boolean-only assertion: no audit-entry content in the result.
    expect(JSON.stringify(result)).not.toContain(RECORD_CONTENT_MARKER);
  });

  it("★ positive control: {\"<id>\": []} (enabled but NOT recording) classifies 'degraded', never 'ok'", async () => {
    // THE flair#970 row. read_audit_log answers HTTP 200 with a well-formed
    // empty history — exactly what a base-copied node returns (harper#2212).
    // The pre-fix world had no check here at all, so this state passed
    // silently. If you put data in and can't see it come back, the pipeline
    // is broken, not empty.
    mockServer({ auditEntriesFor: () => [] });

    const result = await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    expect(result.state).toBe("degraded");
    if (result.state === "degraded") expect(result.cause).toBe("not-recording");
  });

  it("returns 'degraded' when only ONE of the two writes was recorded (partial recording)", async () => {
    mockServer({ auditEntriesFor: (id) => [entryFor(id, "upsert")] });
    const result = await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    expect(result.state).toBe("degraded");
    if (result.state === "degraded") expect(result.cause).toBe("not-recording");
  });

  it("does not count a DELETE entry toward the two write entries", async () => {
    // Only delete entries present — the write pipeline still isn't recording.
    mockServer({ auditEntriesFor: (id) => [entryFor(id, "delete"), entryFor(id, "delete")] });
    const result = await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    expect(result.state).toBe("degraded");
  });

  it("returns 'degraded' (cause: disabled) on HTTP 400 — audit disabled in the root config", async () => {
    // harper@5.2.0 (live-verified): read_audit_log → 400 "To use this
    // operation audit log must be enabled in harperdb-config.yaml" when
    // logging.auditLog is off. The remedy callers render names the knob in
    // the ROOT harperdb-config.yaml, not flair's component config.yaml.
    mockServer({ auditStatus: 400 });
    const result = await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    expect(result.state).toBe("degraded");
    if (result.state === "degraded") expect(result.cause).toBe("disabled");
  });

  it("returns 'skipped' when the ops API is unreachable (rendered UNVERIFIED, never a pass)", async () => {
    mockServer({ opsThrows: true });
    const result = await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    expect(result.state).toBe("skipped");
    if (result.state === "skipped") {
      expect(result.reason).toBe("probe-failed");
      expect(result.detail).toContain("unreachable");
    }
  });

  it("returns 'skipped' on an unexpected read_audit_log status (401) — cannot verify is not verified", async () => {
    // A 401/403/5xx from the ops API says nothing about whether audit
    // records. It must land in skipped (UNVERIFIED), never in ok or degraded.
    mockServer({ auditStatus: 401, auditBody: { error: "unauthorized" } });
    const result = await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    expect(result.state).toBe("skipped");
  });

  it("returns 'skipped' when no agent id or key is available", async () => {
    const emptyKeysDir = mkdtempSync(join(tmpdir(), "flair-doctor-audit-empty-"));
    const prev = process.env.FLAIR_AGENT_ID;
    delete process.env.FLAIR_AGENT_ID;
    try {
      const result = await verifyAuditLog(BASE_URL, undefined, emptyKeysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
      expect(result.state).toBe("skipped");
      if (result.state === "skipped") expect(result.reason).toBe("no-agent");
    } finally {
      if (prev !== undefined) process.env.FLAIR_AGENT_ID = prev;
      rmSync(emptyKeysDir, { recursive: true, force: true });
    }
  });

  it("returns 'skipped' when no admin credentials are available for the ops API", async () => {
    // No probe write may happen either: without ops credentials the check
    // cannot complete, so it must not leave side effects behind.
    const calls = mockServer({ auditEntriesFor: () => [] });
    const result = await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, undefined);
    expect(result.state).toBe("skipped");
    if (result.state === "skipped") expect(result.reason).toBe("no-admin-credentials");
    expect(calls.length).toBe(0);
  });

  it("returns 'skipped' when the probe row cannot be written", async () => {
    mockServer({ putStatus: 503 });
    const result = await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    expect(result.state).toBe("skipped");
    if (result.state === "skipped") expect(result.reason).toBe("probe-failed");
  });

  it("deletes the probe row (finally) even when classification is degraded", async () => {
    const calls = mockServer({ auditEntriesFor: () => [] });
    await verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/Memory/flair-doctor-audit-probe-"))).toBe(true);
  });

  it("never echoes audit-entry content into degraded/skipped results either", async () => {
    // Same boolean-only guard as the ok case, on the degraded path: mocked
    // entries carry a distinctive record image; the result must not.
    const withEntries = await (async () => {
      mockServer({ auditEntriesFor: (id) => [entryFor(id, "upsert")] });
      return verifyAuditLog(BASE_URL, AGENT_ID, keysDir, OPS_URL, ADMIN_USER, ADMIN_PASS);
    })();
    expect(JSON.stringify(withEntries)).not.toContain(RECORD_CONTENT_MARKER);
  });
});
