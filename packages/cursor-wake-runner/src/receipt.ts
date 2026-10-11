/**
 * The sourced launch receipt a wake handoff ATTEMPTS to record (flair#1944,
 * slice 2 of flair#1940).
 *
 * After a dispatch is handed to a Cursor Cloud Agent ("created" or "already"),
 * the runner attempts one receipt as its own agent: a STABLE id derived from the
 * OrgEvent id, deterministic content naming only the dispatch id and the launched
 * Cursor agent id, and — when the Cursor agent id passes the server's host-source
 * grammar — a `hostSource` `{ host: "cursor", kind: "launch", id: <cursorAgentId>,
 * url?: <url> }` claiming where the launch lives. A receipt whose Cursor id the
 * grammar refuses is stored WITHOUT a pointer: it is not "sourced", and it gets no
 * bootstrap citation (see Scope below).
 * A receipt the runner treats as a non-retryable refusal is acked without one.
 *
 * A live receipt run requires the agent's own Ed25519 signing key (flair#1944
 * round 4): under admin Basic credentials the server would stamp the written
 * pointer with the Basic username while the row's `agentId` is
 * `FLAIR_AGENT_ID`, so the receipt could not be verified on replay. Basic
 * credentials are accepted only for the read-only modes (`--dry-run`).
 *
 * Scope: the write is PRIVATE and omits `hostSourceScope`, so the server's read
 * projection keeps the pointer AUTHOR-ONLY. An ordinary non-author cannot read
 * this private row at all — it answers 404 to them — so they never see the
 * pointer; an admin CAN read the row, but an admin/operator bootstrap takes no
 * pointer join for it. `withheld` applies only to a non-author who can read the
 * row after its visibility changes (for instance it is later shared): they read
 * the record but not the pointer, and see `hostSource: "withheld"`. When a
 * pointer was stored AND the memory is selected for bootstrap, bootstrap PROSE
 * cites that pointer to a reader who may see it (flair#2446): this memory's author
 * sees the short `[via cursor/launch <id8> (unverified)]` citation (host/kind and
 * the first 8 id characters, display-only — the full url never appears there), and
 * a reader who may read the memory but not the pointer sees `[via withheld]`; an
 * admin bootstrap takes no pointer join. A memory with no pointer — a receipt whose
 * Cursor id the grammar refused stores none — gets no citation at all. A
 * `hostSource` is the writer's claim, not verified host authorship.
 *
 * The id is the Cursor agent id: on create, the id Cursor returned (the
 * requested id when the response carries none); on a 409 replay, the requested
 * id, which Cursor reported as already in use. The url is set only on create,
 * and only as Cursor returned it. A value the server's host-source grammar would
 * refuse is omitted — never rewritten — so the receipt still lands IF THE
 * REMAINING WRITE SUCCEEDS; the server checks and stores each value's NFC form,
 * and so does this mirror's check. The grammar is mirrored from
 * resources/host-source.ts (packages never import server code);
 * test/host-source-parity.test.ts runs this mirror and the server's
 * validateHostSource over the same inputs and asserts they agree.
 */

import { DNS_NAMESPACE, uuidFromSha256 } from "./uuid.js";

/** Namespace for receipt memory ids — distinct from the `bc-` agent-id namespace. */
export const RECEIPT_NAMESPACE = uuidFromSha256("flair.cursor.launch-receipt", DNS_NAMESPACE);

/**
 * The server's host-source id grammar (`resources/host-source.ts`,
 * `HOST_SOURCE_ID_RE`, flair#1940 A2). Mirrored here so the runner decides
 * BEFORE the write: the server refuses a pointer whose id fails it, and a
 * refused write would lose the whole receipt.
 */
const HOST_SOURCE_ID_RE = /^[A-Za-z0-9._:/@#-]{1,256}$/;

/** The server's url cap (`HOST_SOURCE_URL_MAX`), in characters. */
const HOST_SOURCE_URL_MAX = 2048;

/** Control characters and the full bidi set (`resources/host-source.ts`). */
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/** A `hostSource` the receipt claims: the Cursor launch this memory is about. */
export interface CursorLaunchSource {
  host: "cursor";
  kind: "launch";
  id: string;
  url?: string;
}

/** The record a receipt store writes. */
export interface LaunchReceipt {
  id: string;
  content: string;
  hostSource?: CursorLaunchSource;
}

/** The identity a stored receipt row is read back as — the fields the
 *  existing-receipt check compares before it calls a row this runner's receipt. */
export interface StoredReceipt {
  /** The stored row's author (the server's `Memory.agentId`). */
  author: string;
  /** The stored row's content. */
  content: string;
  /** The stored row's joined host-source pointer, or `"withheld"` when the
   *  reader may read the record but not its pointer. Absent when the row carries
   *  no pointer. */
  hostSource?: CursorLaunchSource | "withheld";
}

/**
 * Read/decide the launch receipt store. `read` returns the stored row's
 * identity (see {@link StoredReceipt}) — or null when none is READABLE at the id:
 * missing, or HIDDEN from this reader (a foreign PRIVATE row reads as a 404). A
 * `get` that returns null on 404 and THROWS on any other failure — an unknown
 * read must never license a write; `write` puts the record. A live `write` must
 * be signed as the runner's own agent: the production store sets
 * `requireSigningKey`, and the client fails closed (no Basic fallback) when no
 * Ed25519 key resolves.
 */
export interface ReceiptStore {
  /**
   * The agent this store signs receipts AS — its signing identity. The store is
   * built from ONE client and takes that client's OWN `agentId`, so it is always
   * signed as EXACTLY the agent whose feed the runner drained; there is no
   * separate label to supply and a mismatched signer is unrepresentable.
   */
  readonly agentId: string;
  read: (id: string) => Promise<StoredReceipt | null>;
  write: (receipt: LaunchReceipt) => Promise<void>;
}

/** Stable, deterministic receipt memory id for a dispatch OrgEvent id. */
export function launchReceiptId(eventId: string): string {
  if (!eventId) throw new Error("launchReceiptId requires a non-empty OrgEvent id");
  return `cursor-launch-receipt-${uuidFromSha256(eventId, RECEIPT_NAMESPACE)}`;
}

/**
 * True when `id` is a Cursor agent id the server accepts as `hostSource.id`:
 * free of control/bidi characters, and within the id grammar once
 * NFC-normalised — the server normalises BEFORE it checks (and stores the
 * normalised form), so checking the raw string would refuse e.g. U+212A KELVIN
 * SIGN, which the server accepts as "K".
 */
export function isAcceptableHostSourceId(id: string): boolean {
  if (FORBIDDEN.test(id)) return false;
  return HOST_SOURCE_ID_RE.test(id.normalize("NFC"));
}

/**
 * True when `url` is an https URL the host-source grammar accepts, checked the
 * way the server checks it (resources/host-source.ts): free of control/bidi
 * characters, then — on its NFC form — within the length cap, parseable, https,
 * and without userinfo (including an empty `@`). The cap applies AFTER
 * normalisation: NFC can lengthen a string (U+0958 becomes two code units), so
 * a raw-length check would pass a url the server refuses.
 */
export function isAcceptableHostSourceUrl(url: string): boolean {
  if (FORBIDDEN.test(url)) return false;
  const normalized = url.normalize("NFC");
  if (normalized.length === 0 || normalized.length > HOST_SOURCE_URL_MAX) return false;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const authority = normalized.replace(/^https:\/\//i, "").split(/[/?#]/)[0];
  return !authority.includes("@") && parsed.username === "" && parsed.password === "";
}

/**
 * The `hostSource` a launch receipt claims, or `undefined` when the server
 * would refuse the Cursor agent id (then the source is omitted). `url` is
 * included only when the server would accept it; any other url is omitted,
 * never altered. Values are sent as returned; the server stores their NFC form.
 */
export function cursorLaunchHostSource(
  cursorAgentId: string,
  url?: string,
): { hostSource?: CursorLaunchSource; omittedUrl: boolean; omittedSource: boolean } {
  if (!isAcceptableHostSourceId(cursorAgentId)) {
    return { omittedUrl: url !== undefined, omittedSource: true };
  }
  const hostSource: CursorLaunchSource = { host: "cursor", kind: "launch", id: cursorAgentId };
  if (url === undefined) return { hostSource, omittedUrl: false, omittedSource: false };
  if (isAcceptableHostSourceUrl(url)) {
    hostSource.url = url;
    return { hostSource, omittedUrl: false, omittedSource: false };
  }
  return { hostSource, omittedUrl: true, omittedSource: false };
}

/**
 * Build the receipt for a handed-off dispatch: the stable id, the
 * deterministic content (dispatch id + Cursor agent id only — never dispatch
 * text or the prompt), and the host source, omitting a url the grammar would
 * refuse. The caller gates the url on a `created` outcome (flair#1944 round 6):
 * an `already` (409) replay contributes no url, so a serialized replay that reads
 * the existing receipt cannot overwrite the create's stored url (the two-runner
 * race is disclosed, not claimed away).
 */
export function buildLaunchReceipt(
  dispatchId: string,
  launch: { cursorAgentId: string; url?: string },
): { receipt: LaunchReceipt; omittedUrl: boolean; omittedSource: boolean } {
  const id = launchReceiptId(dispatchId);
  const content = `Cursor launch receipt for dispatch ${dispatchId}: Cursor Cloud Agent ${launch.cursorAgentId}.`;
  const { hostSource, omittedUrl, omittedSource } = cursorLaunchHostSource(launch.cursorAgentId, launch.url);
  return {
    receipt: { id, content, ...(hostSource ? { hostSource } : {}) },
    omittedUrl,
    omittedSource,
  };
}

/**
 * Whether a row already stored at a receipt id IS this runner's receipt — the
 * ONE identity check the existing-receipt path makes before it calls the row
 * "unchanged" and acks. All of these must hold:
 *   - the row's author is the runner's OWN agent (`stored.author === agentId`);
 *   - the row's content EQUALS the deterministic receipt content; and
 *   - the row's host-source IDENTITY (`host`/`kind`/`id`) matches the receipt's —
 *     a `"withheld"` pointer, or a different id, is not a match.
 * The url is NOT part of the identity: a create stores the url Cursor returned,
 * a replay (409) carries none, and the stored one stands.
 *
 * A row that fails any of these is NOT VERIFIED as this runner's receipt (a
 * collision, or another agent's shared memory). The caller must fail WITHOUT
 * acking and WITHOUT overwriting it. A foreign PRIVATE row is not readable by
 * the runner, so it reads as ABSENT: the runner attempts the write, and the
 * server refuses that write instead.
 */
export function isStoredReceipt(
  stored: StoredReceipt | null | undefined,
  agentId: string,
  receipt: LaunchReceipt,
): boolean {
  if (!stored) return false;
  if (stored.author !== agentId) return false;
  if (stored.content !== receipt.content) return false;
  return sameSourceIdentity(receipt.hostSource, stored.hostSource);
}

/** The host-source IDENTITY (`host`/`kind`/`id`) of two pointers matches: a
 *  `"withheld"` pointer never matches, and absence matches only absence. The id
 *  is compared on its NFC form (the form the server's validator STORES): the
 *  runner builds the expected id from the value Cursor returned, while a
 *  read-back row carries the server's normalised form, so a raw `===` would call
 *  a legitimate replay of a normalisable id (e.g. a KELVIN-SIGN `K`) a mismatch. */
function sameSourceIdentity(
  expected: CursorLaunchSource | undefined,
  stored: CursorLaunchSource | "withheld" | undefined,
): boolean {
  if (stored === "withheld") return false;
  if (expected === undefined) return stored === undefined;
  if (stored === undefined) return false;
  // The server stores host/kind/id in NFC; compare the same form on both sides.
  const nfc = (s: string) => s.normalize("NFC");
  return nfc(expected.host) === nfc(stored.host) && nfc(expected.kind) === nfc(stored.kind) && nfc(expected.id) === nfc(stored.id);
}

/**
 * HTTP statuses the runner treats as NON-RETRYABLE for a receipt write
 * (flair#1944): a malformed or invalid request (400), a conflict (409), a body
 * too large (413), an unprocessable request (422). The runner treats these
 * statuses as non-retryable. Every other failure — a network error, a timeout,
 * 401/403, 408, 429, any 5xx, any other status — is treated as transient or a
 * configuration fault and retried next cycle.
 */
export const RECEIPT_PERMANENT_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 409, 413, 422]);

/** A receipt write the runner treats as a non-retryable refusal: its status and
 *  error code only. */
export interface ReceiptRefusal {
  status: number;
  /** The server's named error code (`{"error": "<code>"}`), when present; null when the body carries none. */
  code: string | null;
}

/** A named error code: a short lowercase token, never free text from the body. */
const ERROR_CODE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

function errorCodeFrom(body: unknown): string | null {
  if (typeof body !== "string" || body.length === 0) return null;
  let code: unknown;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) code = (parsed as Record<string, unknown>).error;
  } catch {
    // FlairError keeps at most 500 characters of the body, so a long JSON body
    // arrives truncated; the server writes `error` first, so read it from the head.
    code = /^\s*\{\s*"error"\s*:\s*"([^"\\]{1,64})"/.exec(body)?.[1];
  }
  return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : null;
}

/**
 * Classify a receipt WRITE failure. Returns the refusal when the error carries
 * an HTTP `status` (flair-client's FlairError exposes `status` and the response
 * `body`) in {@link RECEIPT_PERMANENT_REFUSAL_STATUSES}; otherwise null, and the
 * caller keeps the watermark back and retries. Only the status and the named
 * error code, when present, are returned — never the server's message, which can
 * echo the submitted values.
 */
export function permanentReceiptRefusal(err: unknown): ReceiptRefusal | null {
  if (!err || typeof err !== "object") return null;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number" || !RECEIPT_PERMANENT_REFUSAL_STATUSES.has(status)) return null;
  return { status, code: errorCodeFrom((err as { body?: unknown }).body) };
}
