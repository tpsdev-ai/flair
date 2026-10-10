/**
 * The launch receipt a successful wake handoff records (flair#1944, slice 2 of
 * flair#1940).
 *
 * After a dispatch is handed to a Cursor Cloud Agent ("created" or "already"),
 * the runner writes ONE memory as its own agent: a STABLE id derived from the
 * OrgEvent id, deterministic content naming only the dispatch id and the
 * launched Cursor agent id, and a `hostSource` `{ host: "cursor", kind:
 * "launch", id: <cursorAgentId>, url?: <url> }` claiming where the launch lives.
 *
 * The id and url reach other agents' bootstrap as an unverified citation
 * (flair#2446). The id is the Cursor agent id: on create, the id Cursor
 * returned (the requested id when the response carries none); on a 409 replay,
 * the requested id, which Cursor reported as already in use. The url is set
 * only on create, and only as Cursor returned it. A value the server's
 * host-source grammar would refuse is omitted — never rewritten — so the
 * receipt still lands; the server checks and stores each value's NFC form, and
 * so does this mirror's check. The grammar is mirrored from
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

/**
 * Read/decide the launch receipt store. `has` answers whether a receipt with
 * this id already exists (a `get` that returns null on 404 and THROWS on any
 * other failure — an unknown read must never license a write); `write` puts
 * the record.
 */
export interface ReceiptStore {
  has: (id: string) => Promise<boolean>;
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
 * refuse.
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
 * HTTP statuses that mean the server will refuse the SAME receipt write again
 * (flair#1944): a malformed or invalid request (400), a conflict (409), a body
 * too large (413), an unprocessable request (422). Retrying such a write can
 * never succeed, and because a replay reaches the same write (Cursor 409 ->
 * "already" -> no receipt yet -> write), holding the watermark for it would
 * block every later dispatch for this agent forever. Every other failure —
 * a network error, a timeout, 401/403, 408, 429, any 5xx, any other status —
 * is treated as transient or a configuration fault and retried next cycle.
 */
export const RECEIPT_PERMANENT_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 409, 413, 422]);

/** A receipt write the server permanently refused: its status and error code only. */
export interface ReceiptRefusal {
  status: number;
  /** The server's named error code (`{"error": "<code>"}`), or null when the body carries none. */
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
 * caller keeps the watermark back and retries. Only the status and a named
 * error code are returned — never the server's message, which can echo the
 * submitted values.
 */
export function permanentReceiptRefusal(err: unknown): ReceiptRefusal | null {
  if (!err || typeof err !== "object") return null;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number" || !RECEIPT_PERMANENT_REFUSAL_STATUSES.has(status)) return null;
  return { status, code: errorCodeFrom((err as { body?: unknown }).body) };
}
