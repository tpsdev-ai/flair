/**
 * Bind a Flair client to the receipt store the wake runner writes through.
 *
 * flair#1944: the receipt is a normal memory written as the runner's own agent.
 * `read` reads the record first and returns its identity (author, content and
 * the joined pointer), or null when there is none; `memory.get` resolves to null
 * ONLY on a 404 and throws on any other failure, so an unreadable store can
 * never read as "no receipt" and license a write (flair#2446's
 * unverified-citation rule). A refused `write` throws the client's FlairError,
 * whose HTTP `status` and `body` the runner reads to tell a non-retryable
 * refusal from a retryable failure (receipt.ts, permanentReceiptRefusal).
 */

import type { FlairClient } from "@tpsdev-ai/flair-client";
import type { CursorLaunchSource, ReceiptStore } from "./receipt.js";

export function createMemoryReceiptStore(client: FlairClient): ReceiptStore {
  return {
    read: async (id) => {
      const existing = await client.memory.get(id);
      if (existing === null) return null;
      const { hostSource } = existing;
      return {
        author: existing.agentId,
        content: existing.content,
        ...(hostSource === undefined
          ? {}
          : hostSource === "withheld"
            ? { hostSource: "withheld" as const }
            : { hostSource: { host: hostSource.host, kind: hostSource.kind, id: hostSource.id } as CursorLaunchSource }),
      };
    },
    write: async (receipt) => {
      await client.memory.write(receipt.content, {
        id: receipt.id,
        ...(receipt.hostSource ? { hostSource: receipt.hostSource } : {}),
      });
    },
  };
}
