import { tables } from "harperdb";

export class Memory extends (tables as any).Memory {
  async post(target: unknown, record: any) {
    record.durability ||= "standard";
    record.createdAt = new Date().toISOString();
    record.updatedAt = record.createdAt;

    if (record.durability === "ephemeral" && !record.expiresAt) {
      const ttlHours = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);
      record.expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    }

    return super.post(target, record);
  }

  async delete(target: unknown) {
    const record = await this.get(target);
    if (record?.durability === "permanent") {
      return new Response(JSON.stringify({ error: "permanent_memory_cannot_be_deleted" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return super.delete(target);
  }
}
