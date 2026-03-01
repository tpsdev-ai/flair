import { tables } from "harperdb";

export class Memory extends (tables as any).Memory {
  async post(content: any, context?: any) {
    content.durability ||= "standard";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;

    if (content.durability === "ephemeral" && !content.expiresAt) {
      const ttlHours = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);
      content.expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    }

    return super.post(content, context);
  }

  async put(content: any) {
    content.updatedAt = new Date().toISOString();
    return super.put(content);
  }

  async delete(id: any, context?: any) {
    const record = await this.get(id);
    if (record?.durability === "permanent") {
      return new Response(JSON.stringify({ error: "permanent_memory_cannot_be_deleted" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return super.delete(id, context);
  }
}
