/**
 * control.test.ts — flair#1436.
 *
 * Unit test over the negative-control decision alone. Pure inputs, no Harper,
 * no model, no CI lane. The control's PASS must carry information: it must be
 * able to FAIL. The NaN case is the one that matters — a failed warm-up yields
 * 0 tokens over 0 ms → 0/0 = NaN, and the gate must BLOCK on that, never
 * proceed on missing data.
 */
import { describe, expect, test } from "bun:test";
import { decideNegativeControl } from "./control";

const THRESHOLD = 0.75;

describe("decideNegativeControl (flair#1436)", () => {
  test("low materially slower than high → not blocked", () => {
    expect(decideNegativeControl(100, 800, THRESHOLD).blocked).toBe(false);
  });

  test("low not materially slower than high → blocked (known-answer)", () => {
    expect(decideNegativeControl(790, 800, THRESHOLD).blocked).toBe(true);
  });

  test("NaN tokPerSec (failed warm-up) → blocked, never proceed on missing data", () => {
    expect(decideNegativeControl(NaN, 800, THRESHOLD).blocked).toBe(true);
  });
});
