import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRecordId, memoryPutPath } from "../src/record-id-path.ts";
import { seedSession } from "../src/continuity.ts";
import { runCapture } from "../src/continuity-capture-hook.ts";

/**
 * flair#1970 — the captured-journal path construction (the continuity capture
 * hook's `/Memory/<id>` PUT, built by `memoryPutPath` in ./record-id-path.ts)
 * ENCODES the id as ONE path segment, and REFUSES a `.`/`..` id before any
 * request.
 *
 * The hook's own rows carry a journal id that is URL-safe by construction, so
 * driving the whole hook cannot exercise the encoder (flair#1970 item 3: a
 * test that interpolates a safe id passes with raw interpolation). These pin
 * the extracted builder directly with a reserved-character id instead.
 */
describe("capture PUT path: Memory id encoding (#1970)", () => {
  test("a reserved-character id is one encoded path segment that decodes back", () => {
    const id = "sess#1?x/y%z w";
    const path = memoryPutPath(id);

    // Exactly one segment after /Memory/ — a naive `#` would start a fragment,
    // `?` a query, `/` split the segment, and `%`/space would be malformed.
    expect(path.startsWith("/Memory/")).toBe(true);
    const segment = path.slice("/Memory/".length);
    expect(segment).toBe(encodeURIComponent(id)); // assertion: the id is percent-encoded
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("?");
    expect(segment).not.toContain("#");
    expect(decodeURIComponent(segment)).toBe(id);
  });

  test("a '.'/'..' id is refused (nothing to send)", () => {
    for (const bad of [".", ".."]) {
      expect(() => memoryPutPath(bad)).toThrow(/dot-segment/); // assertion: the rule is named
      expect(() => memoryPutPath(bad)).toThrow(`record id ${JSON.stringify(bad)}`); // assertion: the id is named literally
    }
  });
});

/**
 * The dot-id refusal through the REAL request path (flair#1970 item 3): the
 * continuity capture hook builds `memoryPutPath(row.id)` and sends it via
 * `client.request`. A journal row's id is URL-safe by construction, so the id
 * is injected through the hook's `buildRow` seam; the request spy must stay
 * untouched for either dot id.
 */
describe("capture request path: a '.'/'..' row id sends NOTHING (#1970)", () => {
  test("each dot id is refused before any request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-mcp-1970-"));
    try {
      seedSession(dir, "agent-a", "sess-1");
      for (const bad of [".", ".."]) {
        const calls: Array<{ method: string; path: string }> = [];
        const client = {
          request: async (method: string, path: string) => {
            calls.push({ method, path });
            return {};
          },
        };
        const outcome = await runCapture(
          JSON.stringify({
            hook_event_name: "PostToolUse",
            session_id: "sess-1",
            tool_name: "Write",
            tool_input: { file_path: "/tmp/a.ts" },
          }),
          {
            sessionDir: dir,
            env: { FLAIR_AGENT_ID: "agent-a" },
            makeClient: () => client,
            buildRow: () => ({ id: bad }),
          },
        );
        expect(outcome.wrote).toBe(false); // assertion: refused (no write)
        expect(calls).toHaveLength(0); // assertion: the request spy is untouched
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
