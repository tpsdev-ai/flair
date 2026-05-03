import { BaseListChatMessageHistory } from "@langchain/core/chat_history";
import {
  type BaseMessage,
  type StoredMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from "@langchain/core/messages";
import type { FlairClient } from "@tpsdev-ai/flair-client";

/**
 * LangChain `BaseListChatMessageHistory` adapter backed by Flair memory.
 *
 * Each chat message is stored as a single Flair memory:
 *   - content: JSON.stringify(StoredMessage)
 *   - subject: the composed chat-session subject
 *   - tags: ["n8n-chat", `role:<type>`]
 *   - type: "session"
 *   - durability: "ephemeral"
 *
 * `getMessages()` reads memories filtered by subject and reconstructs the
 * BaseMessage[] in createdAt-ascending order. Order is computed client-side
 * from the createdAt timestamp because Memory.list does not yet expose a
 * server-side sort param (tracked as the `order` extension in q3qf §6).
 *
 * The `windowK` constructor argument bounds the number of memories fetched
 * per `getMessages()` call: each turn is two messages (user + AI), so we
 * fetch up to `windowK * 2` to cover a windowing wrapper that keeps the
 * last K turns.
 */
export class FlairChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ["n8n-nodes", "flair"];

  constructor(
    private readonly client: FlairClient,
    private readonly subject: string,
    private readonly windowK: number = 10,
  ) {
    super();
  }

  async getMessages(): Promise<BaseMessage[]> {
    const memories = await this.client.memory.list({
      subject: this.subject,
      type: "session",
      limit: this.windowK * 2,
    });
    // Server returns most recent first by default; sort by createdAt asc
    // so chat history reads chronologically (oldest first).
    const sorted = [...memories].sort((a, b) => {
      const ta = (a as any).createdAt ?? "";
      const tb = (b as any).createdAt ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    const stored: StoredMessage[] = sorted
      .map((m) => {
        try {
          return JSON.parse(m.content) as StoredMessage;
        } catch {
          // Memory content isn't a valid StoredMessage envelope — skip
          // rather than throw. Most likely a memory written by another
          // surface (CLI, MCP, another agent) sharing the subject.
          return null;
        }
      })
      .filter((s): s is StoredMessage => s !== null);
    return mapStoredMessagesToChatMessages(stored);
  }

  async addMessage(message: BaseMessage): Promise<void> {
    const [stored] = mapChatMessagesToStoredMessages([message]);
    await this.client.memory.write(JSON.stringify(stored), {
      type: "session",
      durability: "ephemeral",
      subject: this.subject,
      tags: ["n8n-chat", `role:${stored.type}`],
    });
  }

  async addMessages(messages: BaseMessage[]): Promise<void> {
    // Flair has no batch-write today; fall back to sequential writes.
    // BaseListChatMessageHistory's default does the same loop — the
    // override exists so future flair-client batch support can drop in
    // here without touching consumers.
    for (const m of messages) await this.addMessage(m);
  }

  async clear(): Promise<void> {
    // Best-effort delete of all session memories under this subject.
    const memories = await this.client.memory.list({
      subject: this.subject,
      type: "session",
      limit: 1000,
    });
    for (const m of memories) {
      try {
        await this.client.memory.delete(m.id);
      } catch {
        // best-effort — keep deleting siblings
      }
    }
  }
}
