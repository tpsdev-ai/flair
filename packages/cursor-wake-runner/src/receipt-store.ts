/**
 * Bind a Flair client to the receipt store the wake runner writes through.
 *
 * flair#1944: the receipt is a normal memory written as the runner's own agent.
 * `read` reads the record first and returns its identity (author, content and
 * the joined pointer), or null when none is READABLE there — the id is missing,
 * or a foreign PRIVATE row holds it and reads as absent (the server answers 404
 * to this reader); `memory.get` resolves to null ONLY on a 404 and throws on any
 * other failure, so an unreadable store can never read as "no receipt" and
 * license a write (flair#2446's unverified-citation rule). A refused `write`
 * throws the client's FlairError, whose HTTP `status` and `body` the runner
 * reads to tell a non-retryable refusal from a retryable failure (receipt.ts,
 * permanentReceiptRefusal).
 *
 * flair#1944 round 5: a live receipt `write` REQUIRES the agent's own Ed25519
 * signing key. The production store passes `requireSigningKey` so the client
 * fails closed at SEND time rather than falling back to admin Basic credentials
 * (whose username the server would stamp in place of the agent's identity). The
 * refusal is named and the caller keeps the watermark back, so the next cycle
 * retries it. Removing the key file cannot cause a Basic fallback: a key the
 * client has already loaded is CACHED and still signs (the file is not re-read),
 * and when no key resolves at send time the client refuses rather than sending
 * Basic.
 *
 * flair#1944 round 7: the store signs as EXACTLY the client's agent — it takes
 * the client and uses the client's OWN `agentId` as its signing identity. There
 * is no second agent label to supply or disagree with, so a store that signs as
 * a different agent than the runner is unrepresentable: whoever builds the
 * runner from a client gets a store bound to that same client. This signing
 * identity is what a LIVE run writes with; a dry-run run writes no receipt at all.
 */

import { MissingSigningKeyError } from "@tpsdev-ai/flair-client";
import type { FlairClient } from "@tpsdev-ai/flair-client";
import type { CursorLaunchSource, ReceiptStore } from "./receipt.js";

export function createMemoryReceiptStore(client: FlairClient): ReceiptStore {
  return {
    // The store's signing identity IS the client's — no separate label to trust.
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
