import { createHash } from "node:crypto";
import { stripInlinePointerFields } from "./host-source-visibility.js";

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
      // flair#1940 A1' item 1: a row returned to a caller must never carry an
      // inline pointer field — drop any raw writer's leftovers with the same
      // helper the read projection uses.
      return stripInlinePointerFields(record);
    }
  }

  return null;
}
