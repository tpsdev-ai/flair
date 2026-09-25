/**
 * The PairingToken rollback's REPORTING (flair#1895).
 *
 * `flair federation token` persists a PairingToken, then creates the bootstrap
 * user that redeems it. When the user cannot be created the token is rolled
 * back — and a rollback is only real when Harper CONFIRMS the delete. A `delete`
 * answers 200 even when it removes nothing, naming what it removed in
 * `deleted_hashes` and a record it did NOT remove in `skipped_hashes`
 * (flair#1899). These tests drive the reporting rule directly (the delete leg is
 * proven against a live Harper in test/integration/federation-token-rollback.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { pairingTokenRollbackLine, rollbackPairingToken } from "../../src/commands/federation.js";
import { redactTokenMessage } from "../../src/lib/redact-token-id.js";

// Long enough that its 8-character prefix is a strict prefix — a shorter id
// would make "the whole id never appears" vacuous.
const TOKEN = "pair-token-live-abcdefghijklmnop";
const PREFIX = TOKEN.slice(0, 8);

describe("pairing token rollback reporting (flair#1895)", () => {
  test("a confirmed delete reports a rollback, naming the token by its prefix only", () => {
    const line = pairingTokenRollbackLine({ deleted_hashes: [TOKEN] }, TOKEN);
    expect(line).toContain("Rolled back pairing token");
    expect(line).toContain(PREFIX);
    expect(line).not.toContain("FAILED");
    // Never the whole id.
    expect(line).not.toContain(TOKEN);
  });

  test("a delete that names the token in skipped_hashes reports FAILED, not confirmed", () => {
    const line = pairingTokenRollbackLine({ deleted_hashes: [], skipped_hashes: [TOKEN] }, TOKEN);
    expect(line).toContain("rollback FAILED");
    expect(line).toContain(PREFIX);
    expect(line).not.toContain("Rolled back pairing token");
    expect(line).not.toContain(TOKEN);
  });

  test("a result carrying an error reports FAILED and redacts the id the error echoed", () => {
    const line = pairingTokenRollbackLine({ error: `delete refused for ${TOKEN}` }, TOKEN);
    expect(line).toContain("rollback FAILED");
    expect(line).toContain(PREFIX);
    // The error text echoed the full id; it must not survive into the line.
    expect(line).not.toContain(TOKEN);
  });

  test("a result that names no ids at all is not a confirmation", () => {
    const line = pairingTokenRollbackLine({}, TOKEN);
    expect(line).toContain("rollback FAILED");
    expect(line).not.toContain("Rolled back pairing token");
  });

  test("both changed and skipped is not a confirmation", () => {
    const line = pairingTokenRollbackLine(
      { deleted_hashes: [TOKEN], skipped_hashes: [TOKEN] },
      TOKEN,
    );
    expect(line).toContain("rollback FAILED");
  });

  test("the shared redactor cuts every occurrence of the id to its prefix", () => {
    expect(redactTokenMessage(`a ${TOKEN} b ${TOKEN}`, [TOKEN])).toBe(`a ${PREFIX}… b ${PREFIX}…`);
  });

  test("the rollback sends hash_values (the field Harper requires) and reports the confirmation", async () => {
    const original = globalThis.fetch;
    const bodies: any[] = [];
    globalThis.fetch = ((_url: string, init: any) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        new Response(JSON.stringify({ deleted_hashes: [TOKEN] }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    try {
      const line = await rollbackPairingToken("http://127.0.0.1:9925", "Basic x", TOKEN);
      expect(bodies).toHaveLength(1);
      expect(bodies[0].operation).toBe("delete");
      expect(bodies[0].table).toBe("PairingToken");
      // The field Harper's delete schema requires; the singular one is refused.
      expect(bodies[0].hash_values).toEqual([TOKEN]);
      expect(bodies[0].hash_value).toBeUndefined();
      expect(line).toContain("Rolled back pairing token");
      expect(line).not.toContain(TOKEN);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a rollback whose request throws reports FAILED and does not throw", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      return Promise.reject(new Error("ECONNREFUSED"));
    }) as unknown as typeof fetch;
    try {
      const line = await rollbackPairingToken("http://127.0.0.1:9925", "Basic x", TOKEN);
      expect(line).toContain("rollback FAILED");
      expect(line).not.toContain("Rolled back pairing token");
      expect(line).not.toContain(TOKEN);
    } finally {
      globalThis.fetch = original;
    }
  });
});