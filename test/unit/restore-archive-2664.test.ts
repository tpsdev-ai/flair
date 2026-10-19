/**
 * restore-archive-2664.test.ts — flair#2664 slice 1a: restore archive
 * validation (src/lib/restore-archive.ts).
 *
 * Every refusal case starts from an archive the validator accepts and changes
 * exactly one thing, then asserts the one refusal that change produces; every
 * acceptance case asserts the classification its rule decides.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_PROMOTION_STATUSES,
  parseRestoreArchive,
  parseStrictJson,
  selectMemoryIds,
  validateRestoreMemoryRow,
  validateRestoreSelection,
  type RestoreArchive,
  type RestoreEntryFailure,
} from "../../src/lib/restore-archive.ts";
import { promotionContentHash } from "../../src/lib/promotion-content-hash.ts";
import { applyPromotionBinding, promotionContentHash as serverPromotionContentHash } from "../../resources/promotion-binding.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENT = "agent-a";
const PROMOTED_AT = "2026-10-02T00:00:00.000Z";

type Row = Record<string, unknown>;

function memory(id: string, fields: Row = {}): Row {
  return {
    id,
    agentId: AGENT,
    content: `content of ${id}`,
    durability: "persistent",
    createdAt: "2026-10-01T00:00:00.000Z",
    tags: ["note"],
    ...fields,
  };
}

/** An approved verdict bound to its content by the server's binding hash. */
function bound(id: string, fields: Row = {}): Row {
  const content = `reviewed ${id}`;
  return memory(id, {
    content,
    promotionStatus: "approved",
    promotedAt: PROMOTED_AT,
    promotedBy: "reviewer",
    promotionContentHash: promotionContentHash(content),
    ...fields,
  });
}

/** An approved verdict archived before verdicts carried a binding hash. */
function legacy(id: string, fields: Row = {}): Row {
  return memory(id, { promotionStatus: "approved", promotedAt: PROMOTED_AT, promotedBy: "reviewer", ...fields });
}

function backup(memories: Row[] = [memory("m-1")], extra: Row = {}): Row {
  return {
    version: 1,
    createdAt: "2026-10-03T00:00:00.000Z",
    source: "http://flair.invalid",
    agents: [{ id: AGENT, displayName: "Agent A" }],
    souls: [{ id: "soul-1", agentId: AGENT, key: "role", value: "builder" }],
    memories,
    ...extra,
  };
}

/** The bytes `flair backup` writes for `doc` (src/commands/backup.ts). */
function bytes(doc: unknown): Buffer {
  return Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8");
}

function sha256(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function accepted(doc: unknown): RestoreArchive {
  const result = parseRestoreArchive(bytes(doc));
  if (!result.ok) throw new Error(`expected the archive to parse: ${result.code} ${result.reason} at ${result.location}`);
  return result.archive;
}

/** Validate one row inside an otherwise valid archive; return its failures. */
function rowFailures(row: Row): readonly RestoreEntryFailure[] {
  const result = validateRestoreSelection(accepted(backup([row])));
  if (result.ok) return [];
  expect(result.code).toBe("entries-refused");
  return result.failures;
}

function expectOnlyFailure(row: Row, code: RestoreEntryFailure["code"], field: string): void {
  expect(rowFailures(row).map(({ id, code, field }) => ({ id, code, field }))).toEqual([{ id: row.id as string, code, field }]);
}

function kindOf(row: Row): string {
  const result = validateRestoreSelection(accepted(backup([row])));
  if (!result.ok) throw new Error(`expected the row to validate: ${JSON.stringify(result.failures)}`);
  expect(result.entries).toHaveLength(1);
  return result.entries[0]!.kind;
}

// ─── One buffer: digest and parse ────────────────────────────────────────────

describe("parseRestoreArchive hashes and parses one buffer", () => {
  test("a backup-shaped archive parses to the value JSON.parse returns", () => {
    const doc = backup([memory("m-1"), bound("m-2"), legacy("m-3")]);
    const input = bytes(doc);
    const result = parseRestoreArchive(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archive).toEqual(JSON.parse(input.toString("utf8")));
  });

  test("the digest is the lowercase SHA-256 of the exact input bytes", () => {
    const input = bytes(backup());
    const result = parseRestoreArchive(input);
    expect(result.sha256).toBe(sha256(input));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a whitespace change keeps the archive value and changes the digest", () => {
    const doc = backup([bound("m-1")]);
    const pretty = bytes(doc);
    const compact = Buffer.from(JSON.stringify(doc), "utf8");
    const trailing = Buffer.concat([pretty, Buffer.from(" ")]);
    const results = [pretty, compact, trailing].map((input) => parseRestoreArchive(input));
    for (const result of results) expect(result.ok).toBe(true);
    if (!results[0]!.ok || !results[1]!.ok || !results[2]!.ok) return;
    expect(results[1]!.archive).toEqual(results[0]!.archive);
    expect(results[2]!.archive).toEqual(results[0]!.archive);
    expect(new Set(results.map((result) => result.sha256)).size).toBe(3);
    expect(results.map((result) => result.sha256)).toEqual([sha256(pretty), sha256(compact), sha256(trailing)]);
  });

  test("a refusal carries the digest of the exact input bytes", () => {
    const input = Buffer.from('{"version":1,"version":1,"agents":[],"souls":[],"memories":[]}', "utf8");
    const result = parseRestoreArchive(input);
    expect(result.ok).toBe(false);
    expect(result.sha256).toBe(sha256(input));
  });

  test("a plain Uint8Array and a Buffer of the same bytes give the same result", () => {
    const input = bytes(backup([bound("m-1")]));
    const view = new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    expect(Buffer.isBuffer(view)).toBe(false);
    expect(parseRestoreArchive(view)).toEqual(parseRestoreArchive(input));
  });

  test("an input that is not bytes is a TypeError, not a refusal", () => {
    expect(() => parseRestoreArchive(JSON.stringify(backup()) as unknown as Uint8Array)).toThrow(TypeError);
  });
});

// ─── Duplicate keys ──────────────────────────────────────────────────────────

describe("a repeated object key refuses at any depth", () => {
  const head = '{"version":1,"agents":[],"souls":[],"memories":[';
  const parse = (text: string) => parseRestoreArchive(Buffer.from(text, "utf8"));

  test("JSON.parse keeps the last value of a repeated key, so the parser must decide", () => {
    const text = `${head}{"id":"m","agentId":"a","content":"x","meta":{"seq":1,"seq":2}}]}`;
    expect(JSON.parse(text).memories[0].meta.seq).toBe(2);
  });

  test("a top-level repeated key refuses", () => {
    const result = parse('{"version":1,"agents":[],"souls":[],"memories":[],"memories":[]}');
    expect(result).toMatchObject({ ok: false, code: "duplicate-key", location: "/memories" });
  });

  test("a repeated key in a nested object refuses with its location", () => {
    const result = parse(`${head}{"id":"m","agentId":"a","content":"x","meta":{"seq":1,"seq":2}}]}`);
    expect(result).toMatchObject({ ok: false, code: "duplicate-key", location: "/memories/0/meta/seq" });
  });

  test("a repeated key in an array element refuses with its location", () => {
    const result = parse(`${head}{"id":"m-0","agentId":"a","content":"x"},{"id":"m-1","agentId":"a","content":"x","content":"y"}]}`);
    expect(result).toMatchObject({ ok: false, code: "duplicate-key", location: "/memories/1/content" });
  });

  test("a repeated key in an object inside an array inside an object refuses", () => {
    const result = parse(`${head}{"id":"m","agentId":"a","content":"x","meta":{"list":[{"k":1},{"k":1,"k":2}]}}]}`);
    expect(result).toMatchObject({ ok: false, code: "duplicate-key", location: "/memories/0/meta/list/1/k" });
  });

  test("keys are compared after escape decoding", () => {
    const result = parse(`${head}{"id":"m","agentId":"a","content":"x","\\u0063ontent":"y"}]}`);
    expect(result).toMatchObject({ ok: false, code: "duplicate-key", location: "/memories/0/content" });
  });

  test("a repeated __proto__ key refuses; a single one is kept as an own key", () => {
    expect(parse(`${head}{"id":"m","agentId":"a","content":"x","meta":{"__proto__":1,"__proto__":2}}]}`))
      .toMatchObject({ ok: false, code: "duplicate-key", location: "/memories/0/meta/__proto__" });
    const single = parse(`${head}{"id":"m","agentId":"a","content":"x","meta":{"__proto__":{"polluted":true}}}]}`);
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    const meta = single.archive.memories[0]!.meta as Record<string, unknown>;
    expect(Object.keys(meta)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
    expect((meta as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test("a key pointer escapes '/' and '~'", () => {
    const result = parse(`${head}{"id":"m","agentId":"a","content":"x","meta":{"a/b~c":1,"a/b~c":2}}]}`);
    expect(result).toMatchObject({ ok: false, code: "duplicate-key", location: "/memories/0/meta/a~1b~0c" });
  });

  test("the same key in different objects is not a repeat", () => {
    const result = parse(`${head}{"id":"m-0","agentId":"a","content":"x","meta":{"id":"m-0","content":{"content":1}}},{"id":"m-1","agentId":"a","content":"x"}]}`);
    expect(result.ok).toBe(true);
  });

  test("the offset is the byte offset of the repeated key", () => {
    const text = `${head}{"id":"m","agentId":"a","content":"héllo ✓ \u{1F600}","content":"x"}]}`;
    const input = Buffer.from(text, "utf8");
    const result = parseRestoreArchive(input);
    expect(result).toMatchObject({ ok: false, code: "duplicate-key" });
    expect(result.ok ? undefined : result.offset).toBe(input.lastIndexOf('"content"'));
    expect(input.lastIndexOf('"content"')).not.toBe(text.lastIndexOf('"content"'));
  });
});

// ─── Strict UTF-8 ────────────────────────────────────────────────────────────

describe("the archive bytes decode as strict UTF-8", () => {
  const prefix = Buffer.from('{"version":1,"agents":[],"souls":[],"memories":[{"id":"m","agentId":"a","content":"', "utf8");
  const suffix = Buffer.from('"}]}', "utf8");
  const withContentBytes = (content: number[]) => Buffer.concat([prefix, Buffer.from(content), suffix]);

  test("well-formed multi-byte content decodes exactly", () => {
    const content = "héllo ✓ 中文 \u{1F600}";
    const result = parseRestoreArchive(withContentBytes([...Buffer.from(content, "utf8")]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archive.memories[0]!.content).toBe(content);
  });

  for (const [label, sequence] of [
    ["a byte that never starts a sequence", [0xff]],
    ["a lone continuation byte", [0x80]],
    ["an overlong encoding", [0xc0, 0xaf]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["a sequence cut off by a non-continuation byte", [0xe2, 0x82, 0x41]],
  ] as const) {
    test(`${label} refuses with its offset`, () => {
      const result = parseRestoreArchive(withContentBytes([...sequence]));
      expect(result).toMatchObject({ ok: false, code: "invalid-utf8", location: "" });
      const offset = result.ok ? -1 : result.offset!;
      expect(offset).toBeGreaterThanOrEqual(prefix.length);
      expect(offset).toBeLessThan(prefix.length + sequence.length);
    });
  }

  test("input that ends inside a multi-byte sequence refuses at the end", () => {
    const input = Buffer.concat([prefix, Buffer.from([0xe2, 0x82])]);
    expect(parseRestoreArchive(input)).toMatchObject({ ok: false, code: "invalid-utf8", offset: input.length });
  });

  test("a byte order mark refuses; the same document without it parses", () => {
    const doc = bytes(backup());
    expect(parseRestoreArchive(doc).ok).toBe(true);
    const result = parseRestoreArchive(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), doc]));
    expect(result).toMatchObject({ ok: false, code: "invalid-json", offset: 0 });
  });
});

// ─── Strict JSON grammar ─────────────────────────────────────────────────────

describe("parseStrictJson matches JSON.parse", () => {
  const valid = [
    "0", "-0.5e-3", "1E+2", "123456789012345678901234567890", "1e400", "true", "false", "null",
    '""', '"plain"', '"\\"\\\\\\/\\b\\f\\n\\r\\t"', '"\\u00e9\\u2713\\ud83d\\ude00"', '"\\ud800"',
    '"héllo \u{1F600}"', "[]", "{}", " \t\n\r[ 1 , [ ] , { } ]\n", '{"a":{"b":[1,{"c":null}]},"2":true,"1":false}',
    '{"":1," ":2}',
  ];
  for (const text of valid) {
    test(`accepts ${JSON.stringify(text)}`, () => {
      const result = parseStrictJson(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(JSON.parse(text));
      expect(JSON.stringify(result.value)).toBe(JSON.stringify(JSON.parse(text)));
    });
  }

  test("negative zero stays negative zero", () => {
    const result = parseStrictJson("-0");
    expect(result.ok && Object.is(result.value, -0)).toBe(true);
  });

  test("nesting depth does not bound the parser", () => {
    const depth = 100_000;
    const result = parseStrictJson("[".repeat(depth) + "]".repeat(depth));
    expect(result.ok).toBe(true);
  });

  const invalid = [
    "", " ", "[1,]", '{"a":1,}', "[1 2]", '{"a" 1}', '{"a":1 "b":2}', "{'a':1}", "[01]", "[1.]", "[.5]", "[+1]",
    "[-]", "[1e]", "NaN", "Infinity", "[undefined]", "// c\n1", "/* c */ 1", '"\\x41"', '"\\u12G4"', '"\\u12"',
    '"unterminated', '"tab\there"', '"line\nbreak"', "[1]x", "{} {}", "tru", "nul", '{"a":1}}', "[[]", '{"a":1',
    " 1",
  ];
  for (const text of invalid) {
    test(`refuses ${JSON.stringify(text)}, as JSON.parse does`, () => {
      expect(() => JSON.parse(text)).toThrow();
      expect(parseStrictJson(text)).toMatchObject({ ok: false, code: "invalid-json" });
    });
  }

  test("a syntax refusal names the location of the refused value", () => {
    expect(parseStrictJson('{"memories":[{"id":"m"},{"id":"n","tags":[1,]}]}'))
      .toMatchObject({ ok: false, code: "invalid-json", location: "/memories/1/tags/1" });
  });
});

// ─── Archive shape ───────────────────────────────────────────────────────────

describe("the archive shape matches what flair backup writes", () => {
  const refusal = (doc: unknown) => parseRestoreArchive(bytes(doc));

  test("the base archive used by the refusal cases is accepted", () => {
    expect(parseRestoreArchive(bytes(backup())).ok).toBe(true);
  });

  test("a non-object document refuses", () => {
    for (const doc of [[backup()], "archive", 1, null]) {
      expect(refusal(doc)).toMatchObject({ ok: false, code: "invalid-archive", location: "" });
    }
  });

  test("a version other than the number 1 refuses", () => {
    for (const version of [2, "1", 0, null]) {
      expect(refusal(backup(undefined, { version }))).toMatchObject({ ok: false, code: "unsupported-version", location: "/version" });
    }
    const { version: _omitted, ...missing } = backup();
    expect(refusal(missing)).toMatchObject({ ok: false, code: "unsupported-version", location: "/version" });
  });

  for (const key of ["agents", "souls", "memories"]) {
    test(`a missing or non-array ${key} collection refuses`, () => {
      const { [key]: _omitted, ...missing } = backup();
      expect(refusal(missing)).toMatchObject({ ok: false, code: "invalid-collection", location: `/${key}` });
      for (const value of [{}, "rows", null]) {
        expect(refusal(backup(undefined, { [key]: value }))).toMatchObject({ ok: false, code: "invalid-collection", location: `/${key}` });
      }
    });
  }

  test("a row that is not an object refuses", () => {
    for (const row of [null, ["m"], "m", 1] as unknown[]) {
      expect(refusal(backup([memory("m-0"), row as Row]))).toMatchObject({ ok: false, code: "invalid-row", location: "/memories/1" });
    }
  });

  test("a row id that is not a non-empty string refuses", () => {
    for (const id of [undefined, "", 7, null]) {
      const row = memory("m-1", { id });
      if (id === undefined) delete row.id;
      expect(refusal(backup([row]))).toMatchObject({ ok: false, code: "invalid-row", location: "/memories/0/id" });
    }
  });

  test("a dot-segment row id refuses in every collection", () => {
    for (const id of [".", ".."]) {
      expect(refusal(backup([memory(id)]))).toMatchObject({ ok: false, code: "invalid-row", location: "/memories/0/id" });
      expect(refusal(backup(undefined, { agents: [{ id }] }))).toMatchObject({ ok: false, code: "invalid-row", location: "/agents/0/id" });
    }
    expect(refusal(backup([memory("a/b?c#d%")])).ok).toBe(true);
  });

  test("a Soul or Memory row without a non-empty string agentId refuses; an Agent row needs none", () => {
    expect(refusal(backup([memory("m-1", { agentId: "" })]))).toMatchObject({ ok: false, code: "invalid-row", location: "/memories/0/agentId" });
    expect(refusal(backup(undefined, { souls: [{ id: "soul-1", key: "role", value: "builder" }] })))
      .toMatchObject({ ok: false, code: "invalid-row", location: "/souls/0/agentId" });
    expect(refusal(backup(undefined, { agents: [{ id: AGENT }] })).ok).toBe(true);
  });

  test("a repeated id within a collection refuses at the repeat", () => {
    expect(refusal(backup([memory("m-1"), memory("m-2"), memory("m-1", { content: "other" })])))
      .toMatchObject({ ok: false, code: "duplicate-id", location: "/memories/2/id" });
    expect(refusal(backup(undefined, { souls: [{ id: "s", agentId: AGENT }, { id: "s", agentId: AGENT }] })))
      .toMatchObject({ ok: false, code: "duplicate-id", location: "/souls/1/id" });
  });

  test("the same id in different collections is not a repeat", () => {
    const result = refusal(backup([memory(AGENT)], { souls: [{ id: AGENT, agentId: AGENT }] }));
    expect(result.ok).toBe(true);
  });

  test("an archive without createdAt or source, or with extra fields, is accepted", () => {
    const { createdAt: _c, source: _s, ...bare } = backup();
    expect(refusal(bare).ok).toBe(true);
    expect(refusal(backup(undefined, { note: "extra" })).ok).toBe(true);
  });
});

// ─── Selection ───────────────────────────────────────────────────────────────

describe("selectMemoryIds", () => {
  const archive = () => accepted(backup([memory("m-1"), memory("m-2"), memory("m-3")]));
  const ids = (result: ReturnType<typeof selectMemoryIds>) => (result.ok ? result.rows.map((row) => row.id) : undefined);

  test("without a selection, every Memory row in archive order", () => {
    expect(ids(selectMemoryIds(archive()))).toEqual(["m-1", "m-2", "m-3"]);
  });

  test("a selection returns the named rows in selection order", () => {
    expect(ids(selectMemoryIds(archive(), ["m-3", "m-1"]))).toEqual(["m-3", "m-1"]);
  });

  test("one id the archive does not hold refuses the whole selection", () => {
    const result = selectMemoryIds(archive(), ["m-1", "m-9", "m-2"]);
    expect(result).toMatchObject({ ok: false, code: "entries-refused" });
    expect("rows" in result).toBe(false);
    expect(result.ok ? [] : result.failures.map(({ id, code }) => ({ id, code }))).toEqual([{ id: "m-9", code: "not-in-archive" }]);
  });

  test("every id the archive does not hold is named", () => {
    const result = selectMemoryIds(archive(), ["m-8", "m-1", "m-9"]);
    expect(result.ok ? [] : result.failures.map((failure) => failure.id)).toEqual(["m-8", "m-9"]);
  });

  test("only Memory ids select: an Agent or Soul id is not in the archive's memories", () => {
    for (const id of [AGENT, "soul-1"]) {
      expect(selectMemoryIds(archive(), [id])).toMatchObject({ ok: false, failures: [{ id, code: "not-in-archive" }] });
    }
  });

  test("an id named twice refuses", () => {
    expect(selectMemoryIds(archive(), ["m-1", "m-2", "m-1"])).toMatchObject({
      ok: false,
      code: "entries-refused",
      failures: [{ id: "m-1", code: "duplicate-selection" }],
    });
  });

  test("an empty selection, or an entry that is not a non-empty string, refuses as invalid", () => {
    for (const selection of [[], [""], ["m-1", 2], "m-1"] as unknown as string[][]) {
      expect(selectMemoryIds(archive(), selection)).toMatchObject({ ok: false, code: "invalid-selection", failures: [] });
    }
  });
});

// ─── Promotion admission ─────────────────────────────────────────────────────

describe("validateRestoreSelection admits promotion fields readers can interpret", () => {
  test("restore admission binds with the server's promotion hash function", () => {
    expect(serverPromotionContentHash).toBe(promotionContentHash);
  });

  test("the declared statuses match schemas/memory.graphql", () => {
    const schema = readFileSync(join(REPO, "schemas/memory.graphql"), "utf8");
    const line = schema.split("\n").find((entry) => /^\s*promotionStatus:/.test(entry)) ?? "";
    const declared = [...line.slice(line.indexOf("#")).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...MEMORY_PROMOTION_STATUSES] as string[]).toEqual(declared as string[]);
  });

  test("the base rows used by the refusal cases are accepted", () => {
    const result = validateRestoreSelection(accepted(backup([memory("m-1"), bound("m-2"), legacy("m-3")])));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map(({ id, agentId, kind, promotionStatus }) => ({ id, agentId, kind, promotionStatus }))).toEqual([
      { id: "m-1", agentId: AGENT, kind: "unpromoted", promotionStatus: null },
      { id: "m-2", agentId: AGENT, kind: "bound", promotionStatus: "approved" },
      { id: "m-3", agentId: AGENT, kind: "legacy-unbound", promotionStatus: "approved" },
    ]);
  });

  test("an entry carries its archived row", () => {
    const archive = accepted(backup([bound("m-1")]));
    const result = validateRestoreSelection(archive);
    expect(result.ok && result.entries[0]!.row).toBe(archive.memories[0]!);
  });

  test("a hash equal to the binding of the archived content is bound", () => {
    expect(kindOf(bound("m-1"))).toBe("bound");
  });

  test("an approved verdict with no hash is legacy-unbound, never bound or unpromoted", () => {
    expect(kindOf(legacy("m-1"))).toBe("legacy-unbound");
    expect(kindOf(legacy("m-1", { promotionContentHash: null }))).toBe("legacy-unbound");
  });

  test("a row with no promotion fields, or only null ones, is unpromoted", () => {
    expect(kindOf(memory("m-1"))).toBe("unpromoted");
    expect(kindOf(memory("m-1", { promotionStatus: null, promotedAt: null, promotedBy: null, promotionContentHash: null }))).toBe("unpromoted");
  });

  test("every declared status is admitted", () => {
    for (const status of MEMORY_PROMOTION_STATUSES) {
      expect(kindOf(bound("m-1", { promotionStatus: status }))).toBe("bound");
      expect(kindOf(legacy("m-2", { promotionStatus: status }))).toBe("legacy-unbound");
    }
  });

  test("bound is exactly what the read accessor keeps; legacy-unbound is what it suppresses", () => {
    const rows = [bound("m-1"), legacy("m-2"), memory("m-3", { promotionStatus: "rejected" }), bound("m-4", { promotionStatus: "pending" })];
    for (const row of rows) {
      const kind = kindOf(row);
      const read = applyPromotionBinding(row);
      expect(read.promotionStatus).toBe(kind === "bound" ? row.promotionStatus : null);
    }
  });

  test("an empty content string is a string", () => {
    const content = "";
    expect(kindOf(bound("m-1", { content, promotionContentHash: promotionContentHash(content) }))).toBe("bound");
  });

  // Each case below changes one field of an accepted row.

  test("content that is not a string refuses", () => {
    expectOnlyFailure(memory("m-1", { content: 42 }), "content-not-string", "content");
    expectOnlyFailure(memory("m-1", { content: null }), "content-not-string", "content");
    const missing = memory("m-1");
    delete missing.content;
    expectOnlyFailure(missing, "content-not-string", "content");
  });

  test("a status the schema does not declare refuses", () => {
    for (const promotionStatus of ["promoted", "Approved", "", 1]) {
      expectOnlyFailure(legacy("m-1", { promotionStatus }), "undeclared-promotion-status", "promotionStatus");
    }
  });

  test("an approved verdict without promotedAt refuses", () => {
    expectOnlyFailure(bound("m-1", { promotedAt: "" }), "approved-verdict-incomplete", "promotedAt");
    expectOnlyFailure(bound("m-1", { promotedAt: null }), "approved-verdict-incomplete", "promotedAt");
    expectOnlyFailure(legacy("m-1", { promotedAt: undefined }), "approved-verdict-incomplete", "promotedAt");
  });

  test("an approved verdict without promotedBy refuses", () => {
    expectOnlyFailure(bound("m-1", { promotedBy: "" }), "approved-verdict-incomplete", "promotedBy");
    expectOnlyFailure(legacy("m-1", { promotedBy: null }), "approved-verdict-incomplete", "promotedBy");
  });

  test("a pending or rejected verdict does not need promotedAt or promotedBy", () => {
    expect(kindOf(memory("m-1", { promotionStatus: "rejected" }))).toBe("legacy-unbound");
    expect(kindOf(memory("m-1", { promotionStatus: "pending", promotedAt: "", promotedBy: "" }))).toBe("legacy-unbound");
  });

  test("a verdict field that is not a string refuses", () => {
    expectOnlyFailure(bound("m-1", { promotedAt: 1_759_000_000 }), "invalid-verdict-field", "promotedAt");
    expectOnlyFailure(bound("m-1", { promotedBy: { id: "reviewer" } }), "invalid-verdict-field", "promotedBy");
  });

  test("promotedAt or promotedBy without a status refuses", () => {
    expectOnlyFailure(memory("m-1", { promotedAt: PROMOTED_AT }), "verdict-without-status", "promotedAt");
    expectOnlyFailure(memory("m-1", { promotedBy: "reviewer" }), "verdict-without-status", "promotedBy");
  });

  test("a hash that is not 64 lowercase hex characters refuses", () => {
    const row = bound("m-1");
    const upper = (row.promotionContentHash as string).toUpperCase();
    expect(upper.toLowerCase()).toBe(promotionContentHash(row.content));
    for (const promotionContentHash of [upper, (row.promotionContentHash as string).slice(1), "", 7]) {
      expectOnlyFailure({ ...row, promotionContentHash }, "invalid-binding-hash", "promotionContentHash");
    }
  });

  test("a well-formed hash of different content refuses", () => {
    expectOnlyFailure(bound("m-1", { promotionContentHash: promotionContentHash("different content") }), "binding-mismatch", "promotionContentHash");
  });

  test("the binding is exact: content differing by one space refuses", () => {
    const row = bound("m-1");
    expectOnlyFailure({ ...row, content: `${row.content as string} ` }, "binding-mismatch", "promotionContentHash");
  });

  test("a hash with no verdict refuses, even when it matches the content", () => {
    const content = "content of m-1";
    expectOnlyFailure(memory("m-1", { content, promotionContentHash: promotionContentHash(content) }), "hash-without-verdict", "promotionContentHash");
  });

  test("validateRestoreMemoryRow refuses a row without a restorable shape", () => {
    expect(validateRestoreMemoryRow({ id: "m-1", content: "x" })).toMatchObject({
      ok: false,
      failures: [{ id: "m-1", code: "invalid-row", field: "agentId" }],
    });
    expect(validateRestoreMemoryRow(null)).toMatchObject({ ok: false, failures: [{ id: "", code: "invalid-row" }] });
  });
});

describe("validateRestoreSelection is all-or-nothing", () => {
  const mixed = () => accepted(backup([
    memory("m-1"),
    bound("m-2", { promotionContentHash: promotionContentHash("not the content") }),
    bound("m-3"),
    memory("m-4", { content: 4 }),
    legacy("m-5"),
  ]));

  test("one failing entry refuses the selection and returns no entries", () => {
    const result = validateRestoreSelection(accepted(backup([memory("m-1"), memory("m-2", { content: 2 }), bound("m-3")])));
    expect(result).toMatchObject({ ok: false, code: "entries-refused" });
    expect("entries" in result).toBe(false);
  });

  test("the refusal names every failing id and reason", () => {
    const result = validateRestoreSelection(mixed());
    expect(result.ok ? [] : result.failures.map(({ id, code }) => ({ id, code }))).toEqual([
      { id: "m-2", code: "binding-mismatch" },
      { id: "m-4", code: "content-not-string" },
    ]);
  });

  test("a row with several problems lists each of them", () => {
    const result = validateRestoreSelection(accepted(backup([memory("m-1", { content: 1, promotionStatus: "maybe", promotedBy: 3 })])));
    expect(result.ok ? [] : result.failures.map(({ code, field }) => ({ code, field }))).toEqual([
      { code: "content-not-string", field: "content" },
      { code: "undeclared-promotion-status", field: "promotionStatus" },
      { code: "invalid-verdict-field", field: "promotedBy" },
    ]);
  });

  test("unlisted ids and failing rows are reported together", () => {
    const result = validateRestoreSelection(mixed(), ["m-1", "m-9", "m-4"]);
    expect(result.ok ? [] : result.failures.map(({ id, code }) => ({ id, code }))).toEqual([
      { id: "m-9", code: "not-in-archive" },
      { id: "m-4", code: "content-not-string" },
    ]);
  });

  test("a selection of valid rows is admitted even when unselected rows would fail", () => {
    const result = validateRestoreSelection(mixed(), ["m-5", "m-3", "m-1"]);
    expect(result.ok ? result.entries.map(({ id, kind }) => ({ id, kind })) : result.failures).toEqual([
      { id: "m-5", kind: "legacy-unbound" },
      { id: "m-3", kind: "bound" },
      { id: "m-1", kind: "unpromoted" },
    ]);
  });

  test("a selection refusal is returned before any row is validated", () => {
    expect(validateRestoreSelection(mixed(), [])).toMatchObject({ ok: false, code: "invalid-selection", failures: [] });
  });

  test("an archive built without the parser still cannot admit a repeated Memory id", () => {
    const archive = { version: 1, agents: [], souls: [], memories: [memory("m-1"), memory("m-1", { content: "other" })] } as unknown as RestoreArchive;
    expect(validateRestoreSelection(archive)).toMatchObject({ ok: false, failures: [{ id: "m-1", code: "duplicate-id" }] });
    expect(validateRestoreSelection(archive, ["m-1"])).toMatchObject({ ok: false, failures: [{ id: "m-1", code: "duplicate-id" }] });
  });
});
