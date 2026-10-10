/**
 * Bind a Flair client to the receipt store the wake runner writes through.
 *
 * flair#1944: the receipt is a normal memory written as the runner's own agent.
 * `has` reads the record first; `memory.get` resolves to null ONLY on a 404 and
 * throws on any other failure, so an unreadable store can never read as "no
 * receipt" and license a write (flair#2446's unverified-citation rule).
 */

import type { FlairClient } from "@tpsdev-ai/flair-client";
import type { ReceiptStore } from "./receipt.js";

export function createMemoryReceiptStore(client: FlairClient): ReceiptStore {
  return {
    has: async (id) => {
      const existing = await client.memory.get(id);
      return existing !== null;
    },
    write: async (receipt) => {
      await client.memory.write(receipt.content, {
        id: receipt.id,
        ...(receipt.hostSource ? { hostSource: receipt.hostSource } : {}),
      });
    },
  };
}
