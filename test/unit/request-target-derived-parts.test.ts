import { describe, expect, test } from "bun:test";
import {
  requestQuery,
  whatwgQueryMatchesRawTarget,
  whatwgUrlMatchesRawTarget,
} from "../../resources/request-target.ts";

describe("requestQuery", () => {
  test("returns an empty string without a query or after a trailing question mark", () => {
    expect(requestQuery("/Memory/x")).toBe("");
    expect(requestQuery("/Memory/x?")).toBe("");
  });

  test("returns everything after the first question mark unchanged", () => {
    expect(requestQuery("/Memory/x?value=a?b&value=c")).toBe("value=a?b&value=c");
    expect(requestQuery("/Memory/x?value=%23")).toBe("value=%23");
    expect(requestQuery("/Memory/x?value=a#b")).toBe("value=a#b");
  });
});

describe("whatwgUrlMatchesRawTarget", () => {
  test("matches an ordinary target with or without a query", () => {
    expect(whatwgUrlMatchesRawTarget("/Memory/x")).toBe(true);
    expect(whatwgUrlMatchesRawTarget("/Memory/x?limit=1")).toBe(true);
  });

  test("matches a percent-encoded hash in the path and query", () => {
    expect(whatwgUrlMatchesRawTarget("/Memory/x%23y?value=%23")).toBe(true);
  });

  test("does not match a trailing question mark", () => {
    expect(whatwgUrlMatchesRawTarget("/Memory/x?")).toBe(false);
  });

  test("does not match a raw hash", () => {
    expect(whatwgUrlMatchesRawTarget("/Memory/x#y")).toBe(false);
    expect(whatwgUrlMatchesRawTarget("/Memory/x?value=a#b")).toBe(false);
  });

  test("returns false when URL parsing throws", () => {
    expect(whatwgUrlMatchesRawTarget("http://[")).toBe(false);
  });
});

describe("whatwgQueryMatchesRawTarget", () => {
  test("matches an ordinary target with or without a query", () => {
    expect(whatwgQueryMatchesRawTarget("/Memory/x")).toBe(true);
    expect(whatwgQueryMatchesRawTarget("/Memory/x?limit=1")).toBe(true);
  });

  test("matches a percent-encoded hash in the path and query", () => {
    expect(whatwgQueryMatchesRawTarget("/Memory/x%23y?value=%23")).toBe(true);
  });

  test("matches the empty query after a trailing question mark", () => {
    expect(whatwgQueryMatchesRawTarget("/Memory/x?")).toBe(true);
  });

  test("matches a raw hash when the query is unchanged", () => {
    expect(whatwgQueryMatchesRawTarget("/Memory/x#y")).toBe(true);
  });

  test("does not match when the parsed query differs", () => {
    expect(whatwgQueryMatchesRawTarget("/Memory/x#y?limit=1")).toBe(false);
    expect(whatwgQueryMatchesRawTarget("/Memory/x?value=a#b")).toBe(false);
  });

  test("returns false when URL parsing throws", () => {
    expect(whatwgQueryMatchesRawTarget("http://[")).toBe(false);
  });
});
