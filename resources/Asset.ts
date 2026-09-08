import { createBlob, databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import {
  FORBIDDEN,
  UNAUTH,
  makeAuthGate,
  makeByIdReadGate,
  makeReadScope,
  resolveAuthGate,
  stampAttribution,
} from "./record-type-kit.js";
import { RECORD_TYPES } from "./record-types.js";

// Kit parameters read FROM RECORD_TYPES.Asset (single source of truth), same
// composition MemoryCandidate.ts uses.
const assetReadScope = makeReadScope(RECORD_TYPES.Asset.readScope, RECORD_TYPES.Asset.ownerField);
const assetByIdReadGate = makeByIdReadGate(assetReadScope);
const assetAuthGate = makeAuthGate();

/**
 * Asset — a binary blob (screenshot/image) owned by an agent and linked to a
 * Memory. Storage slice (images-in-Flair slice 1): lets a spoke (e.g. the
 * Visual Memory Vault) write image bytes into the hub as a Harper Blob and read
 * them back, owner-scoped. No MCP surface yet (RECORD_TYPES.Asset carries no
 * `mcp` field); serving assets through `/mcp` is a separate, security-reviewed
 * slice.
 *
 * Read: identity-gated (anonymous HTTP denied) AND owner-only (an agent sees
 * only its own assets; by-id reads 404-never-403 to avoid an id oracle).
 * Write: self-enforcing — a non-admin agent may create/modify/delete only its
 * own assets (`agentId` no-forge attribution, same idiom as WorkspaceState:
 * stamp on create, validate on update). Admin/internal calls pass unfiltered.
 *
 * Blob handling: a base64 `data` string is decoded and wrapped with
 * `createBlob(..., { type: contentType })` so the bytes are stored decoded and
 * out-of-record, not as the literal base64 text Harper's string coercion would
 * otherwise persist. Write-time gates (Sherlock STOP, this slice): decoded
 * size is capped at MAX_ASSET_DECODED_BYTES, and `contentType` must be an
 * allowlisted `image/*` (XML/SVG subtypes rejected) so a mistyped or
 * unbounded blob cannot land. Non-string `data` without a readable size is
 * rejected (400) rather than persisted unbounded.
 *
 * Lifecycle (Kern P1, this slice): an Asset is retained until its owner
 * deletes the row. Deleting or superseding the parent Memory does not sweep
 * linked blobs — no GC here. Slice 2's serving tool must 404 a dangling
 * memoryId/assetId; the GC sweep lands with that slice. `updatedAt` is
 * stamped on every write so that sweep can key on recency without a second
 * schema change. Harper unlinks blob files when the Asset row is deleted.
 *
 * `memoryId` is an unvalidated, mutable string this slice (exist-and-owned
 * check deferred). Harmless for owner-only reads; slice 2's OAuth-scoped
 * asset URL in memory_search must not assume the parent Memory still exists
 * or is owned by the writer.
 */
export class Asset extends (databases as any).flair.Asset {
  allowRead() { return assetAuthGate.call(this); }

  async get(target?: any) {
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }
    return assetByIdReadGate.call(this, target, (t: any) => super.get(t));
  }

  async search(query?: any) {
    const ctx = (this as any).getContext?.();
    const gate = await resolveAuthGate(ctx, UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.search(query);

    const scope = await assetReadScope(gate.agentId);
    const agentCondition = scope.condition;
    if (!query?.conditions) {
      return super.search({ conditions: [agentCondition], ...(query || {}) });
    }
    return super.search({
      ...query,
      conditions: [agentCondition, { conditions: query.conditions, operator: query.operator || "and" }],
      operator: "and",
    });
  }

  async post(content: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return UNAUTH();

    const attr = stampAttribution(auth, content, RECORD_TYPES.Asset.ownerField, RECORD_TYPES.Asset.attribution.post, "forbidden: cannot store an asset for another agent");
    if (attr.denied) return attr.denied;

    const blobDenial = _coerceBlob(content);
    if (blobDenial) return blobDenial;
    content.createdAt ||= new Date().toISOString();
    content.updatedAt = new Date().toISOString();
    return super.post(content);
  }

  async patch(content: any, query?: any) {
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, RECORD_TYPES.Asset.ownerField);
    if (denial) return denial;
    const blobDenial = _coerceBlob(content);
    if (blobDenial) return blobDenial;
    content.updatedAt = new Date().toISOString();
    return super.patch(content, query);
  }

  async put(content: any) {
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, RECORD_TYPES.Asset.ownerField);
    if (denial) return denial;
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return UNAUTH();

    const attr = stampAttribution(auth, content, RECORD_TYPES.Asset.ownerField, RECORD_TYPES.Asset.attribution.put, "forbidden: cannot modify an asset owned by another agent");
    if (attr.denied) return attr.denied;

    const blobDenial = _coerceBlob(content);
    if (blobDenial) return blobDenial;
    content.updatedAt = new Date().toISOString();
    return super.put(content);
  }

  async delete(id: any, context?: any) {
    const ctx = (this as any).getContext?.();
    const gate = await resolveAuthGate(ctx, UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.delete(id, context);

    const record = await super.get(id);
    if (!record) return super.delete(id, context);
    if (record[RECORD_TYPES.Asset.ownerField] !== gate.agentId) {
      return FORBIDDEN("forbidden: cannot delete an asset owned by another agent");
    }
    return super.delete(id, context);
  }
}

/** Decoded payload cap. Screenshots fit; a multi-GB write is a DoS, not a photo. */
export const MAX_ASSET_DECODED_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_BASE64_CHARS = Math.ceil(MAX_ASSET_DECODED_BYTES * 4 / 3) + 8;

const BAD_REQUEST = (msg: string): Response =>
  new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json" } });

/**
 * Allow `image/*` except XML/SVG subtypes (XSS-capable). Parameters after `;`
 * are stripped; `image/jpg` normalizes to `image/jpeg`.
 */
function normalizeAssetContentType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let base = raw.split(";", 1)[0].trim().toLowerCase();
  if (base === "image/jpg") base = "image/jpeg";
  if (!base.startsWith("image/")) return null;
  const subtype = base.slice("image/".length);
  if (!subtype || subtype.includes("/") || subtype === "svg+xml" || subtype.endsWith("+xml")) return null;
  return base;
}

function decodedSizeOf(data: any): number | undefined {
  if (typeof data?.byteLength === "number") return data.byteLength;
  if (typeof data?.length === "number") return data.length;
  if (typeof data?.size === "number") return data.size;
  return undefined;
}

/**
 * Decode a base64 `data` string into a Harper Blob with the record's MIME type.
 * A caller may also pass an already-created Blob/Buffer, which is left as-is for
 * Harper's own coercion (size still capped when readable). No-op when `data`
 * is absent and `contentType` is not being written.
 *
 * Returns a 400 Response when the write would persist an unbounded or
 * mistyped blob; otherwise undefined.
 */
function _coerceBlob(content: any): Response | undefined {
  if (!content) return;
  const hasType = content.contentType != null && content.contentType !== "";
  if (hasType) {
    const normalized = normalizeAssetContentType(content.contentType);
    if (!normalized) {
      return BAD_REQUEST("invalid contentType: must be an allowlisted image MIME type");
    }
    content.contentType = normalized;
  }

  if (content.data == null) return;

  if (!hasType) {
    return BAD_REQUEST("contentType is required when writing asset data");
  }

  if (typeof content.data === "string") {
    if (content.data.length > MAX_ASSET_BASE64_CHARS) {
      return BAD_REQUEST(`asset exceeds ${MAX_ASSET_DECODED_BYTES} byte decoded size cap`);
    }
    const decoded = Buffer.from(content.data, "base64");
    if (decoded.length > MAX_ASSET_DECODED_BYTES) {
      return BAD_REQUEST(`asset exceeds ${MAX_ASSET_DECODED_BYTES} byte decoded size cap`);
    }
    content.data = createBlob(decoded, { type: content.contentType });
    return;
  }

  const size = decodedSizeOf(content.data);
  if (typeof size !== "number") {
    return BAD_REQUEST("asset data must be a base64 string or a sized binary payload");
  }
  if (size > MAX_ASSET_DECODED_BYTES) {
    return BAD_REQUEST(`asset exceeds ${MAX_ASSET_DECODED_BYTES} byte decoded size cap`);
  }
}
