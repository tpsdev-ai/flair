import { describe, test, expect } from "bun:test";
import {
  abilityOf, isAbstention, selectSlice, parseLmeDate, entryToSessions, TYPE_TO_ABILITY,
  type LmeEntry,
} from "../bench/longmemeval/dataset";

function mkEntry(id: string, type: LmeEntry["question_type"], overrides: Partial<LmeEntry> = {}): LmeEntry {
  return {
    question_id: id,
    question_type: type,
    question: "q",
    answer: "a",
    question_date: "2023/05/30 (Tue) 23:40",
    haystack_dates: ["2023/05/20 (Sat) 02:21"],
    haystack_session_ids: ["s0"],
    haystack_sessions: [[{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]],
    answer_session_ids: [],
    ...overrides,
  };
}

describe("ability mapping", () => {
  test("each question type maps to its ability", () => {
    expect(abilityOf(mkEntry("a", "single-session-user"))).toBe("information-extraction");
    expect(abilityOf(mkEntry("b", "single-session-assistant"))).toBe("information-extraction");
    expect(abilityOf(mkEntry("c", "multi-session"))).toBe("multi-session");
    expect(abilityOf(mkEntry("d", "temporal-reasoning"))).toBe("temporal-reasoning");
    expect(abilityOf(mkEntry("e", "knowledge-update"))).toBe("knowledge-update");
    expect(abilityOf(mkEntry("f", "single-session-preference"))).toBe("single-session-preference");
  });

  test("_abs suffix OVERRIDES the type bucket → abstention", () => {
    const e = mkEntry("q123_abs", "single-session-user");
    expect(isAbstention(e)).toBe(true);
    expect(abilityOf(e)).toBe("abstention"); // not information-extraction
  });

  test("TYPE_TO_ABILITY covers all six types", () => {
    expect(Object.keys(TYPE_TO_ABILITY).length).toBe(6);
  });
});

describe("parseLmeDate", () => {
  test("strips the weekday parenthetical and parses to ISO", () => {
    const iso = parseLmeDate("2023/05/20 (Sat) 02:21");
    expect(iso).toBe("2023-05-20T02:21:00.000Z");
  });
  test("orders correctly (temporal ability depends on it)", () => {
    const a = parseLmeDate("2023/05/20 (Sat) 02:21")!;
    const b = parseLmeDate("2023/05/21 (Sun) 02:21")!;
    expect(new Date(a) < new Date(b)).toBe(true);
  });
  test("empty / unparseable → undefined", () => {
    expect(parseLmeDate("")).toBeUndefined();
  });
});

describe("entryToSessions — per-event, timestamps preserved", () => {
  test("one event per turn, stable ids, session date stamped", () => {
    const sessions = entryToSessions(mkEntry("qX", "single-session-user"));
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.events.length).toBe(2);
    expect(sessions[0]!.events[0]!.id).toBe("qX__s0__t0");
    expect(sessions[0]!.events[0]!.content).toBe("user: hello");
    expect(sessions[0]!.events[0]!.createdAt).toBe("2023-05-20T02:21:00.000Z");
    expect(sessions[0]!.events[0]!.role).toBe("user");
  });
});

describe("selectSlice — deterministic + ability coverage", () => {
  const entries: LmeEntry[] = [];
  const types: LmeEntry["question_type"][] = [
    "single-session-user", "multi-session", "temporal-reasoning", "knowledge-update", "single-session-preference",
  ];
  for (let i = 0; i < 50; i++) entries.push(mkEntry(`q${String(i).padStart(3, "0")}`, types[i % types.length]!));
  for (let i = 0; i < 10; i++) entries.push(mkEntry(`q${String(100 + i).padStart(3, "0")}_abs`, "single-session-user"));

  test("is deterministic for a fixed (n, seed)", () => {
    const a = selectSlice(entries, 12, 0).map((e) => e.question_id);
    const b = selectSlice(entries, 12, 0).map((e) => e.question_id);
    expect(a).toEqual(b);
  });

  test("spans multiple abilities (round-robin), including abstention", () => {
    const slice = selectSlice(entries, 12, 0);
    const abilities = new Set(slice.map((e) => abilityOf(e)));
    expect(abilities.size).toBeGreaterThanOrEqual(5);
    expect(abilities.has("abstention")).toBe(true);
  });

  test("output is sorted by question_id (hash-stable regardless of pick order)", () => {
    const ids = selectSlice(entries, 12, 0).map((e) => e.question_id);
    expect(ids).toEqual([...ids].sort());
  });

  test("a different seed can select a different slice", () => {
    const s0 = selectSlice(entries, 6, 0).map((e) => e.question_id).join(",");
    const s3 = selectSlice(entries, 6, 3).map((e) => e.question_id).join(",");
    expect(s0).not.toBe(s3);
  });
});
