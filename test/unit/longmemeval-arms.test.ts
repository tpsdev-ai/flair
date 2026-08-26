/**
 * longmemeval-arms.test.ts — the v2-dated reader payload (formatRetrieved) and
 * its version stamp in the hashed config.
 *
 * The payload format is a MEASUREMENT VARIANT: it changes what the reader sees,
 * so it must (a) actually carry the dates, and (b) be impossible to change
 * without changing the configHash. Both claims get a positive control here.
 */
import { describe, expect, test } from "bun:test";
import { formatRetrieved, formatFullContext, READER_PAYLOAD_FORMAT } from "../bench/longmemeval/arms";
import { entryToSessions, type LmeEntry } from "../bench/longmemeval/dataset";
import { configManifest, hashConfig } from "../bench/longmemeval/config";
import type { RetrievedItem } from "../../packages/flair-bench/lib/index";

describe("formatRetrieved (v2-dated payload)", () => {
  test("prefixes each memory with its createdAt DATE (date-only, not the timestamp)", () => {
    const items: RetrievedItem[] = [
      { id: "m1", score: 0.9, content: "adopted a puppy named Biscuit", createdAt: "2023-05-20T02:21:00.000Z" },
      { id: "m2", score: 0.8, content: "Biscuit graduated obedience school", createdAt: "2023-07-11T18:00:00.000Z" },
    ];
    expect(formatRetrieved(items)).toBe(
      "- [2023-05-20] adopted a puppy named Biscuit\n" +
      "- [2023-07-11] Biscuit graduated obedience school",
    );
  });

  test("a memory without createdAt falls back to the undated v1 line", () => {
    const items: RetrievedItem[] = [
      { id: "m1", score: 0.9, content: "dated", createdAt: "2024-01-02T00:00:00.000Z" },
      { id: "m2", score: 0.8, content: "undated" },
    ];
    expect(formatRetrieved(items)).toBe("- [2024-01-02] dated\n- undated");
  });

  test("empty retrieval keeps the explicit no-memory marker", () => {
    expect(formatRetrieved([])).toBe("(no relevant memory found)");
  });
});

describe("formatFullContext reports which events it admitted (flair#1358)", () => {
  test("includedEventIds is the events actually written, not a substring scan", () => {
    const entry: LmeEntry = {
      question_id: "qFc",
      question_type: "multi-session",
      question: "q",
      answer: "a",
      question_date: "2023/05/20 (Sat) 02:21",
      haystack_dates: ["2023/05/01 (Mon) 10:00"],
      haystack_session_ids: ["s1"],
      haystack_sessions: [[
        { role: "user", content: "first event" },
        { role: "user", content: "second event" },
      ]],
      answer_session_ids: ["s1"],
    };
    const sessions = entryToSessions(entry);
    const full = formatFullContext(sessions, 1_000_000);
    expect(full.truncated).toBe(false);
    expect(full.includedEventIds).toEqual(sessions[0]!.events.map((e) => e.id));

    const header = `\n[Session ${sessions[0]!.sessionId} — ${sessions[0]!.date}]\n`;
    const firstLine = `${sessions[0]!.events[0]!.role}: ${sessions[0]!.events[0]!.content}\n`;
    const cut = formatFullContext(sessions, header.length + firstLine.length);
    expect(cut.truncated).toBe(true);
    expect(cut.includedEventIds).toEqual([sessions[0]!.events[0]!.id]);
  });
});

describe("reader payload format is part of the hashed config", () => {
  const slice = { n: 2, seed: 0, runs: 1, questionIds: ["qa", "qb"] };

  test("manifest carries the current stamp", () => {
    const m = configManifest(slice) as { prompts: { readerPayloadFormat: string } };
    expect(m.prompts.readerPayloadFormat).toBe(READER_PAYLOAD_FORMAT);
    expect(READER_PAYLOAD_FORMAT).toBe("v2-dated");
  });

  test("positive control: a different payload format hashes differently", () => {
    const m1 = configManifest(slice);
    const m2 = configManifest(slice) as { prompts: { readerPayloadFormat: string } };
    m2.prompts.readerPayloadFormat = "v1";
    expect(hashConfig(m2)).not.toBe(hashConfig(m1));
  });
});
