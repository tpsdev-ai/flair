/**
 * Integration test 3: Quickstart parity — Memory Bank ADK quickstart with
 * FlairMemoryService.
 *
 * Executes the Memory Bank ADK quickstart flow with FlairMemoryService
 * instead of Vertex AI Memory Bank. Confirms cross-session recall.
 *
 * MODEL-CONFIGURABLE via ADK_TEST_MODEL (LiteLLM syntax). When ADK_TEST_MODEL
 * is not set, the agent-loop portion SKIPs with a visible reason.
 *
 * Ported from packages/adk-flair/tests/test_quickstart_parity.py.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { FlairMemoryService, compoundTag } from "../../src/index.js";
import { getLiveFlair, type LiveFlairConfig } from "../helpers/live-flair.js";
import { registerOllamaLlm } from "../helpers/ollama-llm.js";
import type { MemoryEntry } from "@google/adk";
import type { Session } from "@google/adk";
import type { Event } from "@google/adk";
import type { Content } from "@google/genai";
import * as crypto from "node:crypto";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function modelAvailable(): boolean {
  return Boolean(process.env["ADK_TEST_MODEL"]);
}

function skipReason(): string {
  return (
    "ADK_TEST_MODEL not set — agent-loop portion requires a model. " +
    "Set ADK_TEST_MODEL=<liteLLM model string> to run the full quickstart."
  );
}

function makeMemoryEntry(text: string): MemoryEntry {
  return {
    content: { role: "user", parts: [{ text }] } as Content,
  };
}

// Register OllamaLlm if ADK_TEST_MODEL uses the ollama_chat/ prefix.
// adk-js v1.6.0 has no built-in non-Google model class, so this helper
// bridges the gap for self-hosted Ollama models.
if (process.env["ADK_TEST_MODEL"]?.startsWith("ollama_chat/")) {
  registerOllamaLlm();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("QuickstartParity", () => {
  let config: LiveFlairConfig | null = null;
  let service: FlairMemoryService | null = null;

  beforeAll(async () => {
    config = await getLiveFlair();
    if (!config) {
      console.log("SKIP: no live Flair available — skipping quickstart-parity integration tests");
      return;
    }
    service = new FlairMemoryService({
      url: config.httpUrl,
      agentId: config.agentId,
      keyfile: config.keyfilePath,
    });
  }, { timeout: 30_000 });

  afterAll(async () => {
    if (service) await service.close();
    if (config?.cleanup) await config.cleanup();
  }, { timeout: 10_000 });

  it("provision and write", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "quickstart-test-js";
    const user = "test-user-1";

    // 1. add_memory (direct memory entries)
    const memories: MemoryEntry[] = [];
    for (let i = 0; i < 3; i++) {
      memories.push(
        makeMemoryEntry(`Quickstart fact ${i}: the user's favorite color is blue`),
      );
    }
    await service.addMemory(app, user, memories);

    // 2. add_session_to_memory
    const session: Session = {
      id: `qs-sess-${crypto.randomUUID().slice(0, 8)}`,
      appName: app,
      userId: user,
      state: {},
      events: [
        {
          id: `qs-evt-${crypto.randomUUID().slice(0, 8)}`,
          invocationId: crypto.randomUUID(),
          author: "test-agent",
          actions: {} as Event["actions"],
          timestamp: Date.now(),
          content: {
            role: "user",
            parts: [{ text: "Session memory: the user works in software engineering" }],
          } as Content,
        } as Event,
      ],
      lastUpdateTime: Date.now(),
    };
    await service.addSessionToMemory(session);

    // 3. add_events_to_memory
    const events: Event[] = [];
    for (let i = 0; i < 2; i++) {
      events.push({
        id: `qs-evt2-${i}`,
        invocationId: crypto.randomUUID(),
        author: "test-agent",
        actions: {} as Event["actions"],
        timestamp: Date.now(),
        content: {
          role: "user",
          parts: [{ text: `Incremental event ${i}: project deadline is Friday` }],
        } as Content,
      } as Event);
    }
    await service.addEventsToMemory(app, user, events, "qs-sess-2");

    // 4. Verify writes are searchable
    const result1 = await service.searchMemory({
      appName: app,
      userId: user,
      query: "favorite color",
    });
    expect(result1.memories.length).toBeGreaterThan(0);

    const result2 = await service.searchMemory({
      appName: app,
      userId: user,
      query: "software engineering",
    });
    expect(result2.memories.length).toBeGreaterThan(0);

    const result3 = await service.searchMemory({
      appName: app,
      userId: user,
      query: "project deadline",
    });
    expect(result3.memories.length).toBeGreaterThan(0);
  });

  it("cross-session direct", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "quickstart-recall-js";
    const user = "recall-user";

    const secret = `the secret passphrase is 'flair-rocks-${crypto.randomUUID().slice(0, 6)}'`;
    const memory = makeMemoryEntry(secret);
    await service.addMemory(app, user, [memory]);

    // Cross-session recall: search for the fact
    const result = await service.searchMemory({
      appName: app,
      userId: user,
      query: "secret passphrase",
    });

    expect(result.memories.length).toBeGreaterThan(0);
    const found = result.memories.some((m) => {
      const text = (m.content?.parts?.[0] as { text?: string })?.text ?? "";
      return text.includes("flair-rocks");
    });
    expect(found).toBe(true);
  });

  it("cross-session recall (agent loop)", async () => {
    if (!modelAvailable()) {
      console.log(`SKIP: ${skipReason()}`);
      return;
    }
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    // Dynamic import to avoid requiring @google/adk at module load time
    const { Agent } = await import("@google/adk");
    const { Runner } = await import("@google/adk");
    const { InMemorySessionService } = await import("@google/adk");
    const { PRELOAD_MEMORY } = await import("@google/adk");

    const app = "quickstart-recall-agent-js";
    const user = "recall-agent-user";
    const model = process.env["ADK_TEST_MODEL"]!;

    const afterAgentCallback = async (callbackContext: Record<string, unknown>) => {
      const ctxSession = callbackContext["session"] as Session;
      await service!.addEventsToMemory(app, user, ctxSession.events, ctxSession.id);
    };

    const agent = new Agent({
      model,
      name: "recall_agent",
      instruction:
        "You are a helpful assistant with memory. " +
        "Use the preload_memory tool to recall what you know about the user, " +
        "and remember new facts they tell you.",
      tools: [PRELOAD_MEMORY],
      afterAgentCallback,
    });

    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      agent,
      appName: app,
      sessionService,
      memoryService: service,
    });

    // Session 1: plant a fact
    const secretWord = `zephyr-${crypto.randomUUID().slice(0, 6)}`;
    const plantPrompt =
      `Remember this fact about me: my favorite code word is '${secretWord}'. ` +
      `Please acknowledge you've stored it.`;

    const session1 = await sessionService.createSession({ appName: app, userId: user });
    const eventsS1: Event[] = [];
    for await (const event of runner.runAsync({
      userId: user,
      sessionId: session1.id,
      newMessage: {
        role: "user",
        parts: [{ text: plantPrompt }],
      } as Content,
    })) {
      eventsS1.push(event as Event);
    }

    // Session 2: ask for the fact
    const session2 = await sessionService.createSession({ appName: app, userId: user });
    const recallPrompt = "What is my favorite code word?";

    const eventsS2: Event[] = [];
    for await (const event of runner.runAsync({
      userId: user,
      sessionId: session2.id,
      newMessage: {
        role: "user",
        parts: [{ text: recallPrompt }],
      } as Content,
    })) {
      eventsS2.push(event as Event);
    }

    // Assert the fact surfaces in session 2's response
    const s2Texts: string[] = [];
    for (const evt of eventsS2) {
      if (evt.author === "recall_agent") {
        const parts = evt.content?.parts ?? [];
        for (const p of parts) {
          const text = (p as { text?: string }).text;
          if (text) s2Texts.push(text);
        }
      }
    }

    const combined = s2Texts.join(" ").toLowerCase();
    expect(combined).toContain(secretWord.toLowerCase());
  });

  it("agent loop boundary", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    // Verify the service is constructed and healthy
    const marker = `boundary-test-${crypto.randomUUID().slice(0, 8)}`;
    const memory = makeMemoryEntry(marker);
    await service.addMemory("boundary-app", "boundary-user", [memory]);

    const result = await service.searchMemory({
      appName: "boundary-app",
      userId: "boundary-user",
      query: marker,
    });
    expect(result.memories.length).toBeGreaterThan(0);
  });
});
