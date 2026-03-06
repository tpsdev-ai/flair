import { createHash } from "node:crypto";

export function computeContentHash(agentId: string, content: string): string {
  return createHash("sha256")
    .update(`${agentId}${content}`)
    .digest("hex")
    .slice(0, 16);
}

export async function findExistingMemoryByContentHash(
  records: AsyncIterable<any> | Iterable<any>,
  agentId: string,
  contentHash: string,
): Promise<any | null> {
  for await (const record of records) {
    if (record?.agentId === agentId && record?.contentHash === contentHash) {
      return record;
    }
  }

  return null;
}
