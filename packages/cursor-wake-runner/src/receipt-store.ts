/**
 * Bind a Flair client to the receipt store the wake runner writes through.
 *
 * flair#1944: the receipt is a normal memory written as the runner's own agent.
 * `read` reads the record first and returns its identity (author, content and
 * the joined pointer), or null when none is READABLE there — the id is missing,
 * or a foreign PRIVATE row holds it and reads as absent (the server answers 404
 * to this reader); `memory.get` returns null on a 404 and propagates other
 * failures, so a non-404 read failure cannot look absent and license a
 * write. An HTTP-refused `write`
 * throws the client's FlairError, whose HTTP `status` and `body` the runner
 * reads to tell a non-retryable refusal from a retryable failure (receipt.ts,
 * permanentReceiptRefusal).
 *
 * Writes require a resolved signing key; no key means no Basic fallback.
 * A cached key still signs after its file is removed.
 */

import { MissingSigningKeyError } from "@tpsdev-ai/flair-client";
import type { FlairClient } from "@tpsdev-ai/flair-client";
import type { CursorLaunchSource, ReceiptStore } from "./receipt.js";

export function createMemoryReceiptStore(client: FlairClient): ReceiptStore {
  return {
    // The store uses the client's agentId.
    agentId: client.agentId,
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
      try {
        await client.memory.write(receipt.content, {
          id: receipt.id,
          ...(receipt.hostSource ? { hostSource: receipt.hostSource } : {}),
          requireSigningKey: true,
        });
      } catch (err) {
        // flair#1944 round 5 — a live receipt must be signed; the client refuses
        // to send it unsigned. Name the requirement so the failure reads as the
        // same class as the CLI's startup refusal (the event is not acked).
        if (err instanceof MissingSigningKeyError) {
          throw new Error(`cursor-wake: live receipts need the agent's signing key — ${err.message}`);
        }
        throw err;
      }
    },
  };
}
