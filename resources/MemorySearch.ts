import { Resource, tables } from "harperdb";

export class MemorySearch extends Resource {
  async post(data: any, _context?: any) {
    const { agentId, q, tag } = data || {};
    const conditions: any[] = [];
    if (agentId) conditions.push({ attribute: "agentId", comparator: "equals", value: agentId });

    const results: any[] = [];
    for await (const record of (tables as any).Memory.search({ conditions })) {
      if (tag && !(record.tags || []).includes(tag)) continue;
      if (q && !String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      results.push(record);
    }

    return { results };
  }
}
