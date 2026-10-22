/**
 * memory-own-stale-vector-2478.test.ts — flair#2478 slice 3: the check the
 * embedding backfill and the embedding-stamp migration's `.content`-suffix
 * fallback run on retry with the vector and text their unconfirmed attempt
 * staged (resources/memory-embed-hash.ts `holdsOwnStaleVector`).
 *
 * It matches when the row's stored vector equals the staged vector element by
 * element within a float32 tolerance while the row's text is no longer the
 * staged text: the row holds a vector equal to the writer's computation for a
 * text it no longer has. A match does not say which writer stored the vector.
 * The check compares vectors, not the stored text hash: a row with an empty
 * owner stores a null hash, which the hash comparison accepts for any text.
 */
import { describe, expect, it } from "bun:test";
import { embeddedHashMatches, holdsOwnStaleVector } from "../../resources/memory-embed-hash.ts";

const OLD = "the text the attempt embedded";
const NEW = "a text written after the attempt's confirmation";
const vector = (seed: number) => Array.from({ length: 768 }, (_, i) => Math.sin(seed * 1000 + i) / 10);
const STAGED = { embedding: vector(1), text: OLD };

describe("flair#2478 — holdsOwnStaleVector matches a row's stored vector to the vector a writer staged for a text the row no longer has", () => {
  it("an empty-owner row (null hash) holding the staged vector beside a changed text matches", () => {
    const row = { id: "m1", agentId: "", content: NEW, embedding: [...STAGED.embedding], embeddedContentHash: null };
    // The hash comparison accepts it for any text, so it cannot decide the case.
    expect(embeddedHashMatches(row)).toBe(true);
    expect(holdsOwnStaleVector(row, STAGED)).toBe(true);
  });

  it("an owned row holding the staged vector beside a changed text matches", () => {
    const row = { id: "m2", agentId: "agent-a", content: NEW, embedding: [...STAGED.embedding], embeddedContentHash: "stale-hash" };
    expect(holdsOwnStaleVector(row, STAGED)).toBe(true);
  });

  it("the staged vector beside the unchanged staged text does not match", () => {
    const row = { id: "m3", agentId: "", content: OLD, embedding: [...STAGED.embedding], embeddedContentHash: null };
    expect(holdsOwnStaleVector(row, STAGED)).toBe(false);
  });

  it("a vector that differs from the staged one beside a changed text does not match; its provenance is unknown", () => {
    const row = { id: "m4", agentId: "", content: NEW, embedding: vector(2), embeddedContentHash: null };
    expect(holdsOwnStaleVector(row, STAGED)).toBe(false);
  });

  it("nothing staged, no row, no vector, or a vector of another length does not match", () => {
    const row = { id: "m5", agentId: "", content: NEW, embedding: [...STAGED.embedding] };
    expect(holdsOwnStaleVector(row, undefined)).toBe(false);
    expect(holdsOwnStaleVector(null, STAGED)).toBe(false);
    expect(holdsOwnStaleVector({ ...row, embedding: undefined }, STAGED)).toBe(false);
    expect(holdsOwnStaleVector({ ...row, embedding: STAGED.embedding.slice(1) }, STAGED)).toBe(false);
    expect(holdsOwnStaleVector({ ...row, embedding: [0.1, 0.1, 0.1] }, STAGED)).toBe(false);
  });

  it("the staged vector stored at float32 precision still matches", () => {
    const row = { id: "m6", agentId: "", content: NEW, embedding: Float32Array.from(STAGED.embedding), embeddedContentHash: null };
    expect(holdsOwnStaleVector(row, STAGED)).toBe(true);
  });

  it("large-magnitude components stored at float32 precision still match: the tolerance is relative", () => {
    // No code bounds the provider's components, so the comparison must hold at
    // any magnitude: a float32 round trip moves these by far more than 1e-6.
    const staged = { embedding: [100.123456, -12345.678901, 3.4e30, 0.25, -7e-9], text: OLD };
    expect(Math.abs(Math.fround(100.123456) - 100.123456)).toBeGreaterThan(1e-6);
    expect(Math.abs(Math.fround(-12345.678901) + 12345.678901)).toBeGreaterThan(1e-4);
    const row = { id: "m8", agentId: "", content: NEW, embedding: Float32Array.from(staged.embedding), embeddedContentHash: null };
    expect(holdsOwnStaleVector(row, staged)).toBe(true);
  });

  it("a large-magnitude component that differs by more than the relative tolerance does not match", () => {
    const staged = { embedding: [100.123456, -12345.678901, 3.4e30, 0.25], text: OLD };
    const off = [100.123456 * (1 + 1e-5), -12345.678901, 3.4e30, 0.25];
    expect(holdsOwnStaleVector({ id: "m9", agentId: "", content: NEW, embedding: off }, staged)).toBe(false);
    const offLarge = [100.123456, -12345.678901, 3.4e30 * (1 + 1e-5), 0.25];
    expect(holdsOwnStaleVector({ id: "m10", agentId: "", content: NEW, embedding: offLarge }, staged)).toBe(false);
  });

  it("a skill row's embedding text is its trigger: a changed trigger is a changed text", () => {
    const staged = { embedding: vector(3), text: "when to use the old trigger" };
    const row = { id: "m7", agentId: "", tags: ["skill"], trigger: "when to use the new trigger", content: "body", embedding: [...staged.embedding] };
    expect(holdsOwnStaleVector(row, staged)).toBe(true);
    expect(holdsOwnStaleVector({ ...row, trigger: staged.text }, staged)).toBe(false);
  });
});
