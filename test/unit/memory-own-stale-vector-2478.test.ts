/**
 * memory-own-stale-vector-2478.test.ts — flair#2478 slice 3: the attempt-scoped
 * identity the embedding backfill and the embedding-stamp migration's
 * `.content`-suffix fallback keep for their own unconfirmed write
 * (resources/memory-embed-hash.ts `holdsOwnStaleVector`).
 *
 * A row that still holds the exact vector an attempt staged, while its text is
 * no longer the text that vector was computed from, holds that attempt's own
 * vector for text the row no longer has. The identity is the vector, not the
 * stored text hash: a row with an empty owner stores a null hash, which the
 * hash comparison accepts for any text.
 */
import { describe, expect, it } from "bun:test";
import { embeddedHashMatches, holdsOwnStaleVector } from "../../resources/memory-embed-hash.ts";

const OLD = "the text the attempt embedded";
const NEW = "a text written after the attempt's confirmation";
const vector = (seed: number) => Array.from({ length: 768 }, (_, i) => Math.sin(seed * 1000 + i) / 10);
const STAGED = { embedding: vector(1), text: OLD };

describe("flair#2478 — holdsOwnStaleVector identifies a writer's own vector for text the row no longer has", () => {
  it("an empty-owner row (null hash) with the staged vector and a changed text is the writer's stale vector", () => {
    const row = { id: "m1", agentId: "", content: NEW, embedding: [...STAGED.embedding], embeddedContentHash: null };
    // The hash comparison accepts it for any text: it cannot be the identity.
    expect(embeddedHashMatches(row)).toBe(true);
    expect(holdsOwnStaleVector(row, STAGED)).toBe(true);
  });

  it("an owned row with the staged vector and a changed text is the writer's stale vector", () => {
    const row = { id: "m2", agentId: "agent-a", content: NEW, embedding: [...STAGED.embedding], embeddedContentHash: "stale-hash" };
    expect(holdsOwnStaleVector(row, STAGED)).toBe(true);
  });

  it("the staged vector beside the staged text is not stale", () => {
    const row = { id: "m3", agentId: "", content: OLD, embedding: [...STAGED.embedding], embeddedContentHash: null };
    expect(holdsOwnStaleVector(row, STAGED)).toBe(false);
  });

  it("a different vector (another writer's) beside a changed text is not this writer's", () => {
    const row = { id: "m4", agentId: "", content: NEW, embedding: vector(2), embeddedContentHash: null };
    expect(holdsOwnStaleVector(row, STAGED)).toBe(false);
  });

  it("nothing staged, no row, no vector, or a vector of another length is not stale", () => {
    const row = { id: "m5", agentId: "", content: NEW, embedding: [...STAGED.embedding] };
    expect(holdsOwnStaleVector(row, undefined)).toBe(false);
    expect(holdsOwnStaleVector(null, STAGED)).toBe(false);
    expect(holdsOwnStaleVector({ ...row, embedding: undefined }, STAGED)).toBe(false);
    expect(holdsOwnStaleVector({ ...row, embedding: STAGED.embedding.slice(1) }, STAGED)).toBe(false);
    expect(holdsOwnStaleVector({ ...row, embedding: [0.1, 0.1, 0.1] }, STAGED)).toBe(false);
  });

  it("the staged vector stored at float32 precision is still recognised", () => {
    const row = { id: "m6", agentId: "", content: NEW, embedding: Float32Array.from(STAGED.embedding), embeddedContentHash: null };
    expect(holdsOwnStaleVector(row, STAGED)).toBe(true);
  });

  it("a skill row's embedding text is its trigger: a changed trigger is a changed text", () => {
    const staged = { embedding: vector(3), text: "when to use the old trigger" };
    const row = { id: "m7", agentId: "", tags: ["skill"], trigger: "when to use the new trigger", content: "body", embedding: [...staged.embedding] };
    expect(holdsOwnStaleVector(row, staged)).toBe(true);
    expect(holdsOwnStaleVector({ ...row, trigger: staged.text }, staged)).toBe(false);
  });
});
