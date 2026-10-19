/**
 * restore-archive.ts — admission checks for a `flair backup` archive
 * (flair#2664 slice 1a).
 *
 * Pure: no I/O, no Harper, no network, no writes. A restore path hands this
 * module an archive's exact bytes and gets back either a validated archive or
 * a named refusal. Nothing here changes what `flair restore` does today.
 *
 * One buffer. `parseRestoreArchive` copies its input once, hashes that copy
 * (SHA-256, lowercase hex), decodes the same copy as strict UTF-8 and parses
 * the decoded text exactly once. The returned digest is the digest of the
 * bytes the returned archive was parsed from.
 *
 * Strict JSON. `parseStrictJson` accepts the RFC 8259 grammar JSON.parse
 * accepts and builds the same value, except that an object naming one key
 * twice, at any depth, is refused instead of keeping the last value. Keys are
 * compared after escape decoding, so `"a"` and `"\u0061"` are the same key.
 * The parser is iterative, so nesting depth does not bound it.
 *
 * Archive shape: the row checks `flair restore` applies (src/commands/
 * restore.ts) plus unique ids within each collection, over the document
 * `flair backup` writes (src/commands/backup.ts).
 *
 * Archive diagnostics. `parseRestoreArchive` returns the first problem it
 * finds as one refusal with a JSON Pointer `location`. Decoding and JSON-syntax
 * refusals (`invalid-utf8`, `invalid-json`, `duplicate-key`) also carry a byte
 * `offset` into the input; archive-shape refusals carry a location only.
 * `parseStrictJson` reports a UTF-16 `index` into the decoded text, which
 * `parseRestoreArchive` converts to that byte offset.
 *
 * Memory admission: `validateRestoreSelection` checks every selected row's
 * content, and its promotion fields when present, against the binding readers
 * enforce (resources/promotion-binding.ts). The binding hash comes from
 * src/lib/promotion-content-hash.ts, the CLI-side implementation of the
 * server's algorithm; a parity test pins the two together, because a resource
 * may statically import only dependency-free `src/` helpers (flair#1775). It
 * returns either every selected entry validated or a refusal; it
 * never returns part of a selection. The refusal lists every unresolvable id
 * and every failing row, with two single-problem cases: a malformed selection
 * (not an array, empty, or an entry that is not a non-empty string) refuses as
 * `invalid-selection` with no per-id failures, before any id is resolved; and a
 * row whose shape is not restorable (not an object, or no usable id or
 * agentId) reports that one `invalid-row` failure and is not checked further.
 */
import { createHash } from "node:crypto";
import { promotionContentHash } from "./promotion-content-hash.js";
import { encodeRecordId } from "./record-id-path.js";

/** The archive format version `flair backup` writes. */
export const RESTORE_ARCHIVE_VERSION = 1;

/** The `Memory.promotionStatus` values schemas/memory.graphql declares. An
 *  absent or null status means the row carries no verdict. */
export const MEMORY_PROMOTION_STATUSES = Object.freeze(["pending", "approved", "rejected"] as const);

export type MemoryPromotionStatus = (typeof MEMORY_PROMOTION_STATUSES)[number];

/** The archive collections, the table each restores into, and whether its rows
 *  carry an owning `agentId` — in `flair restore`'s order. */
const COLLECTIONS = [
  { key: "agents", table: "Agent", owned: false },
  { key: "souls", table: "Soul", owned: true },
  { key: "memories", table: "Memory", owned: true },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/** An archived row: a JSON object with a non-empty string `id`. */
export interface RestoreArchiveRow {
  readonly id: string;
  readonly [field: string]: unknown;
}

/** An archived Soul or Memory row: it also names its owner. */
export interface RestoreArchiveOwnedRow extends RestoreArchiveRow {
  readonly agentId: string;
}

/** A parsed archive that passed the shape checks. Other top-level fields
 *  (`createdAt`, `source`) are kept as parsed and not checked. */
export interface RestoreArchive {
  readonly version: typeof RESTORE_ARCHIVE_VERSION;
  readonly agents: readonly RestoreArchiveRow[];
  readonly souls: readonly RestoreArchiveOwnedRow[];
  readonly memories: readonly RestoreArchiveOwnedRow[];
  readonly [field: string]: unknown;
}

export type RestoreArchiveRefusalCode =
  | "invalid-utf8"
  | "invalid-json"
  | "duplicate-key"
  | "invalid-archive"
  | "unsupported-version"
  | "invalid-collection"
  | "invalid-row"
  | "duplicate-id";

export interface ParsedRestoreArchive {
  readonly ok: true;
  readonly archive: RestoreArchive;
  /** SHA-256 of the exact input bytes, lowercase hex. */
  readonly sha256: string;
}

export interface RestoreArchiveRefusal {
  readonly ok: false;
  readonly code: RestoreArchiveRefusalCode;
  readonly reason: string;
  /** RFC 6901 JSON Pointer to the refused value; "" is the whole document. */
  readonly location: string;
  /** Byte offset into the input where the refusal was decided. Present on
   *  `invalid-utf8`, `invalid-json` and `duplicate-key` refusals; absent on
   *  archive-shape refusals, which carry `location` only. */
  readonly offset?: number;
  /** SHA-256 of the exact input bytes, lowercase hex. */
  readonly sha256: string;
}

export type RestoreArchiveParseResult = ParsedRestoreArchive | RestoreArchiveRefusal;

export type StrictJsonRefusalCode = "invalid-json" | "duplicate-key";

export type StrictJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | {
    readonly ok: false;
    readonly code: StrictJsonRefusalCode;
    readonly reason: string;
    /** RFC 6901 JSON Pointer to the refused value. */
    readonly location: string;
    /** UTF-16 index into the text where the refusal was decided. */
    readonly index: number;
  };

/**
 * How a validated Memory entry carries its promotion fields:
 * - `bound`: a declared `promotionStatus` and a `promotionContentHash` equal to
 *   the binding hash of the archived content. Readers return the verdict.
 * - `legacy-unbound`: a declared `promotionStatus` (an approved verdict
 *   included) with no `promotionContentHash`. Admitted so a restore can return
 *   the archived fields exactly; ordinary readers suppress all four promotion
 *   fields, and it is not a valid promotion binding.
 * - `unpromoted`: none of the promotion fields is set.
 */
export type RestoreEntryKind = "bound" | "legacy-unbound" | "unpromoted";

export interface ValidatedRestoreEntry {
  readonly id: string;
  readonly agentId: string;
  readonly kind: RestoreEntryKind;
  readonly promotionStatus: MemoryPromotionStatus | null;
  /** The archived row, as parsed. */
  readonly row: RestoreArchiveOwnedRow;
}

export type RestoreEntryFailureCode =
  | "not-in-archive"
  | "duplicate-selection"
  | "duplicate-id"
  | "invalid-row"
  | "content-not-string"
  | "undeclared-promotion-status"
  | "invalid-verdict-field"
  | "verdict-without-status"
  | "approved-verdict-incomplete"
  | "invalid-binding-hash"
  | "hash-without-verdict"
  | "binding-mismatch";

export interface RestoreEntryFailure {
  /** The Memory id the failure concerns ("" when the row has no usable id). */
  readonly id: string;
  readonly code: RestoreEntryFailureCode;
  readonly reason: string;
  /** The archived field the failure concerns, when there is one. */
  readonly field?: string;
}

export interface RestoreSelectionRefusal {
  readonly ok: false;
  /** `invalid-selection`: the selection itself is malformed (no failures).
   *  `entries-refused`: one or more selected ids failed (see `failures`). */
  readonly code: "invalid-selection" | "entries-refused";
  readonly reason: string;
  readonly failures: readonly RestoreEntryFailure[];
}

export type MemorySelectionResult =
  | { readonly ok: true; readonly rows: readonly RestoreArchiveOwnedRow[] }
  | RestoreSelectionRefusal;

export type MemoryRowValidation =
  | { readonly ok: true; readonly entry: ValidatedRestoreEntry }
  | { readonly ok: false; readonly failures: readonly RestoreEntryFailure[] };

export type RestoreSelectionValidation =
  | { readonly ok: true; readonly entries: readonly ValidatedRestoreEntry[] }
  | RestoreSelectionRefusal;

// ─── Shared helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An own property's value; an inherited property reads as absent. */
function ownValue(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

// ─── Strict JSON ─────────────────────────────────────────────────────────────

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x22, "\""], [0x5c, "\\"], [0x2f, "/"], [0x62, "\b"],
  [0x66, "\f"], [0x6e, "\n"], [0x72, "\r"], [0x74, "\t"],
]);

interface ArrayFrame {
  readonly kind: "array";
  readonly value: unknown[];
  readonly pointer: string;
}

interface ObjectFrame {
  readonly kind: "object";
  readonly value: Record<string, unknown>;
  readonly pointer: string;
  readonly keys: Set<string>;
  key: string;
}

type Frame = ArrayFrame | ObjectFrame;

class StrictJsonRefused extends Error {
  readonly code: StrictJsonRefusalCode;
  readonly reason: string;
  readonly location: string;
  readonly index: number;

  constructor(code: StrictJsonRefusalCode, reason: string, location: string, index: number) {
    super(reason);
    this.code = code;
    this.reason = reason;
    this.location = location;
    this.index = index;
  }
}

/** Define an own data property, as JSON.parse does: `__proto__` stays a key. */
function defineMember(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

class StrictJsonParser {
  private readonly text: string;
  private readonly stack: Frame[] = [];
  private i = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(): unknown {
    const { stack, text } = this;
    for (;;) {
      // Read one value, or open a container and continue with its first member.
      let value: unknown;
      this.skipWhitespace();
      const c = text.charCodeAt(this.i);
      if (c === LBRACE) {
        const frame: ObjectFrame = { kind: "object", value: {}, pointer: this.childPointer(), keys: new Set(), key: "" };
        this.i++;
        this.skipWhitespace();
        if (text.charCodeAt(this.i) !== RBRACE) {
          stack.push(frame);
          this.readKey(frame);
          continue;
        }
        this.i++;
        value = frame.value;
      } else if (c === LBRACKET) {
        const frame: ArrayFrame = { kind: "array", value: [], pointer: this.childPointer() };
        this.i++;
        this.skipWhitespace();
        if (text.charCodeAt(this.i) !== RBRACKET) {
          stack.push(frame);
          continue;
        }
        this.i++;
        value = frame.value;
      } else {
        value = this.readScalar(c);
      }
      // Attach the completed value, then close every container it completes.
      for (;;) {
        const top = stack[stack.length - 1];
        if (top === undefined) {
          this.skipWhitespace();
          if (this.i < text.length) throw this.refuse("unexpected data after the JSON document", "");
          return value;
        }
        if (top.kind === "array") top.value.push(value);
        else defineMember(top.value, top.key, value);
        this.skipWhitespace();
        const d = text.charCodeAt(this.i);
        if (d === COMMA) {
          this.i++;
          if (top.kind === "object") {
            this.skipWhitespace();
            this.readKey(top);
          }
          break;
        }
        if (d === (top.kind === "array" ? RBRACKET : RBRACE)) {
          this.i++;
          stack.pop();
          value = top.value;
          continue;
        }
        throw this.refuse(
          top.kind === "array" ? "expected ',' or ']' after an array element" : "expected ',' or '}' after an object member",
          top.pointer,
        );
      }
    }
  }

  private refuse(reason: string, location: string, code: StrictJsonRefusalCode = "invalid-json"): StrictJsonRefused {
    return new StrictJsonRefused(code, reason, location, this.i);
  }

  private skipWhitespace(): void {
    const { text } = this;
    for (;;) {
      const c = text.charCodeAt(this.i);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return;
      this.i++;
    }
  }

  /** The pointer of the value about to be read inside the innermost container. */
  private childPointer(): string {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) return "";
    return `${top.pointer}/${escapePointer(top.kind === "array" ? String(top.value.length) : top.key)}`;
  }

  /** Read `"key" :` and refuse a key this object already holds. */
  private readKey(frame: ObjectFrame): void {
    if (this.text.charCodeAt(this.i) !== QUOTE) throw this.refuse("expected a string object key", frame.pointer);
    const start = this.i;
    const key = this.readString(frame.pointer);
    const location = `${frame.pointer}/${escapePointer(key)}`;
    if (frame.keys.has(key)) {
      this.i = start;
      throw this.refuse(`duplicate object key ${JSON.stringify(key)}`, location, "duplicate-key");
    }
    frame.keys.add(key);
    frame.key = key;
    this.skipWhitespace();
    if (this.text.charCodeAt(this.i) !== COLON) throw this.refuse("expected ':' after an object key", location);
    this.i++;
  }

  private readScalar(c: number): unknown {
    const { text } = this;
    const location = this.childPointer();
    if (c === QUOTE) return this.readString(location);
    if (c === 0x74 && text.startsWith("true", this.i)) { this.i += 4; return true; }
    if (c === 0x66 && text.startsWith("false", this.i)) { this.i += 5; return false; }
    if (c === 0x6e && text.startsWith("null", this.i)) { this.i += 4; return null; }
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      NUMBER_TOKEN.lastIndex = this.i;
      const match = NUMBER_TOKEN.exec(text);
      if (match === null) throw this.refuse("invalid number", location);
      this.i += match[0].length;
      return Number(match[0]);
    }
    if (this.i >= text.length) throw this.refuse("unexpected end of input", location);
    if (this.i === 0 && c === 0xfeff) throw this.refuse("the document begins with a byte order mark", location);
    throw this.refuse("unexpected character", location);
  }

  /** Read a string token starting at its opening quote. */
  private readString(location: string): string {
    const { text } = this;
    let i = this.i + 1;
    let start = i;
    let out = "";
    for (;;) {
      if (i >= text.length) {
        this.i = i;
        throw this.refuse("unterminated string", location);
      }
      const c = text.charCodeAt(i);
      if (c === QUOTE) {
        this.i = i + 1;
        return out + text.slice(start, i);
      }
      if (c === BACKSLASH) {
        out += text.slice(start, i);
        const escape = text.charCodeAt(i + 1);
        if (escape === 0x75) {
          const hex = text.slice(i + 2, i + 6);
          if (!HEX4.test(hex)) {
            this.i = i;
            throw this.refuse("invalid \\u escape", location);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          const simple = SIMPLE_ESCAPES.get(escape);
          if (simple === undefined) {
            this.i = i;
            throw this.refuse("invalid escape sequence", location);
          }
          out += simple;
          i += 2;
        }
        start = i;
        continue;
      }
      if (c < 0x20) {
        this.i = i;
        throw this.refuse("unescaped control character in a string", location);
      }
      i++;
    }
  }
}

/**
 * Parse `text` as one JSON document. A valid document without a repeated key
 * yields the value JSON.parse returns; a repeated key in any object refuses
 * with `duplicate-key`, and any other grammar violation with `invalid-json`.
 */
export function parseStrictJson(text: string): StrictJsonResult {
  try {
    return { ok: true, value: new StrictJsonParser(text).parse() };
  } catch (error) {
    if (!(error instanceof StrictJsonRefused)) throw error;
    return { ok: false, code: error.code, reason: error.reason, location: error.location, index: error.index };
  }
}

// ─── Strict UTF-8 ────────────────────────────────────────────────────────────

function strictUtf8Decoder(): TextDecoder {
  // `ignoreBOM: true` keeps a leading byte order mark in the text, so the
  // parser sees (and refuses) it rather than the decoder dropping bytes the
  // digest covers.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
}

/** The first byte offset the strict decoder refuses, or the input length when
 *  the input ends inside a multi-byte sequence. */
function illFormedUtf8Offset(bytes: Uint8Array): number {
  const acceptsPrefix = (end: number): boolean => {
    try {
      strictUtf8Decoder().decode(bytes.subarray(0, end), { stream: true });
      return true;
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  };
  if (acceptsPrefix(bytes.length)) return bytes.length;
  // acceptsPrefix(lo) holds and acceptsPrefix(hi) does not; a refused prefix
  // stays refused when extended, so the boundary is the first refused byte.
  let lo = 0;
  let hi = bytes.length;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (acceptsPrefix(mid)) lo = mid;
    else hi = mid;
  }
  return hi - 1;
}

type Utf8Decoding = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly offset: number; readonly reason: string };

function decodeStrictUtf8(bytes: Uint8Array): Utf8Decoding {
  try {
    return { ok: true, text: strictUtf8Decoder().decode(bytes) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const offset = illFormedUtf8Offset(bytes);
    return {
      ok: false,
      offset,
      reason: offset === bytes.length
        ? "the input ends inside a multi-byte UTF-8 sequence"
        : "the input is not well-formed UTF-8",
    };
  }
}

// ─── Archive shape ───────────────────────────────────────────────────────────

/** Why `row` is not a restorable row; `field` names the refused field. */
function rowShapeProblem(row: unknown, owned: boolean): { reason: string; field?: string } | undefined {
  if (!isRecord(row)) return { reason: "the row is not a JSON object" };
  const id = ownValue(row, "id");
  if (typeof id !== "string" || id.length === 0) return { reason: "the row id is not a non-empty string", field: "id" };
  try {
    encodeRecordId(id);
  } catch {
    return { reason: "the row id does not address exactly one record path segment", field: "id" };
  }
  if (owned) {
    const agentId = ownValue(row, "agentId");
    if (typeof agentId !== "string" || agentId.length === 0) {
      return { reason: "the row agentId is not a non-empty string", field: "agentId" };
    }
  }
  return undefined;
}

type ShapeRefusal = Pick<RestoreArchiveRefusal, "code" | "reason" | "location">;

function archiveShapeRefusal(doc: unknown): ShapeRefusal | undefined {
  if (!isRecord(doc)) return { code: "invalid-archive", reason: "the archive is not a JSON object", location: "" };
  if (ownValue(doc, "version") !== RESTORE_ARCHIVE_VERSION) {
    return { code: "unsupported-version", reason: `the archive version is not ${RESTORE_ARCHIVE_VERSION}`, location: "/version" };
  }
  for (const { key, table, owned } of COLLECTIONS) {
    const rows = ownValue(doc, key);
    if (!Array.isArray(rows)) {
      return { code: "invalid-collection", reason: `the ${key} collection is missing or not an array`, location: `/${key}` };
    }
    const seen = new Map<string, number>();
    for (let index = 0; index < rows.length; index++) {
      const row: unknown = rows[index];
      const problem = rowShapeProblem(row, owned);
      if (problem) {
        return {
          code: "invalid-row",
          reason: `${table} row ${index}: ${problem.reason}`,
          location: problem.field === undefined ? `/${key}/${index}` : `/${key}/${index}/${problem.field}`,
        };
      }
      const id = (row as RestoreArchiveRow).id;
      const first = seen.get(id);
      if (first !== undefined) {
        return {
          code: "duplicate-id",
          reason: `${table} id ${JSON.stringify(id)} appears more than once (first at /${key}/${first})`,
          location: `/${key}/${index}/id`,
        };
      }
      seen.set(id, index);
    }
  }
  return undefined;
}

/**
 * Hash, decode and parse one archive buffer. The input is copied once; the
 * SHA-256 digest and the parse both read that copy. Refuses ill-formed UTF-8,
 * a leading byte order mark, invalid JSON, a repeated object key at any depth,
 * a version other than 1, a missing or non-array `agents`, `souls` or
 * `memories` collection, a row that is not an object with a non-empty string
 * id addressing one record path segment (Soul and Memory rows also need a
 * non-empty string `agentId`), and a repeated id within a collection.
 * Decoding runs first, then the single parse, which reports whichever syntax
 * error or repeated key it reaches first (a leading byte order mark is refused
 * there). Then comes the version check, then each collection in turn
 * (`agents`, `souls`, then `memories`): first that it is an array, then each
 * row in array order, checking its shape and then that its id is not a
 * repeat. The first problem found is returned as the one refusal. Every
 * result, refusal included, carries the input's digest.
 */
export function parseRestoreArchive(bytes: Buffer | Uint8Array): RestoreArchiveParseResult {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("parseRestoreArchive: expected the archive bytes as a Buffer or Uint8Array");
  }
  const input = new Uint8Array(bytes);
  const sha256 = createHash("sha256").update(input).digest("hex");
  const decoded = decodeStrictUtf8(input);
  if (!decoded.ok) {
    return { ok: false, code: "invalid-utf8", reason: decoded.reason, location: "", offset: decoded.offset, sha256 };
  }
  const parsed = parseStrictJson(decoded.text);
  if (!parsed.ok) {
    const offset = Buffer.byteLength(decoded.text.slice(0, parsed.index), "utf8");
    return { ok: false, code: parsed.code, reason: parsed.reason, location: parsed.location, offset, sha256 };
  }
  const shape = archiveShapeRefusal(parsed.value);
  if (shape) return { ok: false, ...shape, sha256 };
  return { ok: true, archive: parsed.value as RestoreArchive, sha256 };
}

// ─── Memory selection ────────────────────────────────────────────────────────

function selectionRefusal(reason: string): RestoreSelectionRefusal {
  return { ok: false, code: "invalid-selection", reason, failures: [] };
}

function entriesRefused(failures: readonly RestoreEntryFailure[]): RestoreSelectionRefusal {
  const ids = new Set(failures.map((failure) => failure.id));
  return { ok: false, code: "entries-refused", reason: `${ids.size} selected Memory id(s) refused`, failures };
}

/** The selected rows in selection order (archive order when `ids` is
 *  omitted), and a failure for every selected id that does not resolve to
 *  exactly one archived Memory row. */
function resolveSelection(
  archive: RestoreArchive,
  ids: readonly string[] | undefined,
): RestoreSelectionRefusal | { rows: RestoreArchiveOwnedRow[]; failures: RestoreEntryFailure[] } {
  const memories: unknown = archive.memories;
  if (!Array.isArray(memories)) return selectionRefusal("the archive has no memories collection");
  const byId = new Map<string, RestoreArchiveOwnedRow>();
  const repeated = new Set<string>();
  for (const row of memories as RestoreArchiveOwnedRow[]) {
    const id = isRecord(row) ? ownValue(row, "id") : undefined;
    if (typeof id !== "string") continue;
    if (byId.has(id)) repeated.add(id);
    else byId.set(id, row);
  }
  const failures: RestoreEntryFailure[] = [];
  const repeatedFailure = (id: string): RestoreEntryFailure =>
    ({ id, code: "duplicate-id", reason: "the archive holds this Memory id more than once" });
  if (ids === undefined) {
    for (const id of repeated) failures.push(repeatedFailure(id));
    return { rows: [...memories as RestoreArchiveOwnedRow[]], failures };
  }
  if (!Array.isArray(ids)) return selectionRefusal("the selection is not an array of Memory ids");
  if (ids.length === 0) return selectionRefusal("the selection names no Memory ids; omit it to select every Memory row");
  for (let index = 0; index < ids.length; index++) {
    const id: unknown = ids[index];
    if (typeof id !== "string" || id.length === 0) return selectionRefusal(`selection entry ${index} is not a non-empty string`);
  }
  const rows: RestoreArchiveOwnedRow[] = [];
  const selected = new Set<string>();
  const named = new Set<string>();
  for (const id of ids) {
    if (selected.has(id)) {
      if (!named.has(id)) {
        named.add(id);
        failures.push({ id, code: "duplicate-selection", reason: "the selection names this Memory id more than once" });
      }
      continue;
    }
    selected.add(id);
    const row = byId.get(id);
    if (row === undefined) failures.push({ id, code: "not-in-archive", reason: "the archive holds no Memory row with this id" });
    else if (repeated.has(id)) failures.push(repeatedFailure(id));
    else rows.push(row);
  }
  return { rows, failures };
}

/**
 * Resolve an optional selection of Memory ids against the archive. Omitted:
 * every Memory row, in archive order. Given: the named rows in selection
 * order. A selection that is not a non-empty array of non-empty strings
 * refuses as `invalid-selection`, with no per-id failures and before any id
 * is resolved. Otherwise an id the archive does not hold, or names twice,
 * refuses the whole selection as `entries-refused`, listing every such id.
 */
export function selectMemoryIds(archive: RestoreArchive, ids?: readonly string[]): MemorySelectionResult {
  const resolved = resolveSelection(archive, ids);
  if ("ok" in resolved) return resolved;
  if (resolved.failures.length > 0) return entriesRefused(resolved.failures);
  return { ok: true, rows: resolved.rows };
}

// ─── Memory admission ────────────────────────────────────────────────────────

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isDeclaredStatus(value: unknown): value is MemoryPromotionStatus {
  return typeof value === "string" && (MEMORY_PROMOTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Validate one archived Memory row for restore. Requires a restorable row
 * shape, string `content`, and promotion fields readers can interpret:
 * - `promotionStatus`, when set, is a declared value;
 * - `promotedAt` and `promotedBy`, when set, are strings, and are set only
 *   with a `promotionStatus`; an approved verdict has both, non-empty;
 * - `promotionContentHash`, when set, is 64 lowercase hex characters, is set
 *   only with a `promotionStatus`, and equals `promotionContentHash(content)`.
 * Null and absent fields are the same. A row whose shape is not restorable
 * reports that one `invalid-row` failure and is not checked further;
 * otherwise every content and promotion failure is listed. A valid row is
 * classified as `bound`, `legacy-unbound` or `unpromoted`.
 */
export function validateRestoreMemoryRow(row: unknown): MemoryRowValidation {
  const rawId = isRecord(row) ? ownValue(row, "id") : undefined;
  const id = typeof rawId === "string" ? rawId : "";
  const failures: RestoreEntryFailure[] = [];
  const fail = (code: RestoreEntryFailureCode, reason: string, field?: string): void => {
    failures.push(field === undefined ? { id, code, reason } : { id, code, reason, field });
  };

  const shape = rowShapeProblem(row, true);
  if (shape) {
    fail("invalid-row", shape.reason, shape.field);
    return { ok: false, failures };
  }
  const record = row as RestoreArchiveOwnedRow;

  const content = ownValue(record, "content");
  if (typeof content !== "string") fail("content-not-string", "content is not a string", "content");

  const status = ownValue(record, "promotionStatus") ?? null;
  if (status !== null && !isDeclaredStatus(status)) {
    fail("undeclared-promotion-status", `promotionStatus is not one of ${MEMORY_PROMOTION_STATUSES.join(", ")}`, "promotionStatus");
  }

  for (const field of ["promotedAt", "promotedBy"] as const) {
    const value = ownValue(record, field) ?? null;
    if (value !== null && typeof value !== "string") fail("invalid-verdict-field", `${field} is not a string`, field);
    else if (status === null && value !== null) fail("verdict-without-status", `${field} is set without a promotionStatus`, field);
    else if (status === "approved" && (value === null || value === "")) {
      fail("approved-verdict-incomplete", `an approved verdict has no ${field}`, field);
    }
  }

  const hash = ownValue(record, "promotionContentHash") ?? null;
  if (hash !== null) {
    const wellFormed = typeof hash === "string" && SHA256_HEX.test(hash);
    if (!wellFormed) {
      fail("invalid-binding-hash", "promotionContentHash is not 64 lowercase hex characters", "promotionContentHash");
    }
    if (status === null) {
      fail("hash-without-verdict", "promotionContentHash is set without a promotionStatus", "promotionContentHash");
    }
    if (wellFormed && typeof content === "string" && hash !== promotionContentHash(content)) {
      fail("binding-mismatch", "promotionContentHash does not bind the archived content", "promotionContentHash");
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  const kind: RestoreEntryKind = hash !== null ? "bound" : status !== null ? "legacy-unbound" : "unpromoted";
  return {
    ok: true,
    entry: { id, agentId: record.agentId, kind, promotionStatus: status as MemoryPromotionStatus | null, row: record },
  };
}

/**
 * Validate a Memory restore selection before any write. Resolves the optional
 * selection (see `selectMemoryIds`), validates every selected row (see
 * `validateRestoreMemoryRow`), and returns either every selected entry
 * validated, in selection order, or a refusal. A malformed selection returns
 * the single `invalid-selection` refusal `selectMemoryIds` describes, and no
 * row is validated. Otherwise the refusal lists every unresolvable id and
 * every failing row's failures (one `invalid-row` failure for a row whose
 * shape is not restorable). Unselected rows are not validated.
 */
export function validateRestoreSelection(archive: RestoreArchive, ids?: readonly string[]): RestoreSelectionValidation {
  const resolved = resolveSelection(archive, ids);
  if ("ok" in resolved) return resolved;
  const failures = [...resolved.failures];
  const entries: ValidatedRestoreEntry[] = [];
  for (const row of resolved.rows) {
    const result = validateRestoreMemoryRow(row);
    if (result.ok) entries.push(result.entry);
    else failures.push(...result.failures);
  }
  if (failures.length > 0) return entriesRefused(failures);
  return { ok: true, entries };
}
