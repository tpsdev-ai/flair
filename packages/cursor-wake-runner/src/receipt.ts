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
 * (flair#2446), so both are the values Cursor returned VERBATIM: the id is the
 * Cursor agent id, the url is Cursor's agent url. A value the server's
 * host-source grammar would refuse is omitted (never rewritten) so the receipt
 * still lands — see resources/host-source.ts for the grammar this mirrors.
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
 * True when `url` is an https URL the host-source grammar accepts: parseable,
 * https, no userinfo (including an empty `@`), within the length cap, and free
 * of control/bidi characters.
 */
export function isAcceptableHostSourceUrl(url: string): boolean {
  if (url.length === 0 || url.length > HOST_SOURCE_URL_MAX) return false;
  if (FORBIDDEN.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const authority = url.replace(/^https:\/\//i, "").split(/[/?#]/)[0];
  return !authority.includes("@") && parsed.username === "" && parsed.password === "";
}

/**
 * The `hostSource` a launch receipt claims, or `undefined` when the Cursor
 * agent id is not valid under the server's id grammar (then the source is
 * omitted). `url` is included only when it is an https value the grammar
 * accepts; an unacceptable url is omitted, never altered.
 */
export function cursorLaunchHostSource(
  cursorAgentId: string,
  url?: string,
): { hostSource?: CursorLaunchSource; omittedUrl: boolean; omittedSource: boolean } {
  if (!HOST_SOURCE_ID_RE.test(cursorAgentId)) {
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
