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
 * otherwise persist.
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

    _coerceBlob(content);
    content.createdAt ||= new Date().toISOString();
    return super.post(content);
  }

  async patch(content: any, query?: any) {
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, RECORD_TYPES.Asset.ownerField);
    if (denial) return denial;
    _coerceBlob(content);
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

    _coerceBlob(content);
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

/**
 * Decode a base64 `data` string into a Harper Blob with the record's MIME type.
 * A caller may also pass an already-created Blob/Buffer, which is left as-is for
 * Harper's own coercion. No-op when `data` is absent.
 */
function _coerceBlob(content: any): void {
  if (content && typeof content.data === "string") {
    content.data = createBlob(Buffer.from(content.data, "base64"), {
      type: content.contentType || "application/octet-stream",
    });
  }
}
