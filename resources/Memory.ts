import { tables } from "harperdb";
import { isAdmin } from "./auth-middleware.js";

export class Memory extends (tables as any).Memory {
  async post(content: any, context?: any) {
    content.durability ||= "standard";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    content.archived = content.archived ?? false;

    if (content.durability === "ephemeral" && !content.expiresAt) {
      const ttlHours = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);
      content.expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    }

    return super.post(content, context);
  }

  async put(content: any, context?: any) {
    const now = new Date().toISOString();
    content.updatedAt = now;

    // If archiving, record who + when
    if (content.archived === true && !content.archivedAt) {
      content.archivedAt = now;
      // archivedBy should be set by the caller (CLI stamps req.tpsAgent via query param)
    }

    // If approving promotion, record timestamp
    if (content.promotionStatus === "approved" && !content.promotedAt) {
      content.promotedAt = now;
    }

    // Upgrade to permanent when approved
    if (content.promotionStatus === "approved") {
      content.durability = "permanent";
    }

    return super.put(content, context);
  }

  async delete(id: any, context?: any) {
    const record = await this.get(id);
    if (!record) return super.delete(id, context);

    if (record.durability === "permanent") {
      // Middleware already guards this for non-admins, but belt-and-suspenders
      const actorId = context?.request?.tpsAgent;
      if (actorId && !(await isAdmin(actorId))) {
        return new Response(JSON.stringify({ error: "permanent_memory_cannot_be_deleted_by_non_admin" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return super.delete(id, context);
  }
}
