// gha-expression.test.ts — the expression evaluator that merge-group-workflows.test.ts
// uses to ask what a workflow resolves to for one event. A wrong evaluator would
// make those workflow tests pass or fail for the wrong reason.

import { describe, expect, test } from "bun:test";

import { evaluate, evaluateIf, evaluateValue } from "../helpers/gha-expression.ts";

const ctx = {
  github: { event_name: "merge_group", head_ref: "", event: { merge_group: { base_sha: "abc" }, pull_request: null } },
  steps: { "queued-pr": { outputs: { login: "renovate[bot]" } } },
  needs: { build: { result: "success" } },
};

describe("operators", () => {
  test("|| and && return an operand", () => {
    expect(evaluate("github.event.pull_request.base.sha || github.event.merge_group.base_sha", ctx)).toBe("abc");
    expect(evaluate("github.event_name == 'pull_request' && 'pr' || 'other'", ctx)).toBe("other");
    expect(evaluate("'' || null", ctx)).toBeNull();
    expect(evaluate("'a' && 'b'", ctx)).toBe("b");
  });

  test("== and != compare strings case-insensitively and null equal to null", () => {
    expect(evaluate("github.event_name == 'MERGE_GROUP'", ctx)).toBe(true);
    expect(evaluate("github.event_name != 'pull_request'", ctx)).toBe(true);
    expect(evaluate("github.event.pull_request == null", ctx)).toBe(true);
  });

  test("! negates truthiness, and '' / null / 0 / false are falsy", () => {
    for (const falsy of ["''", "null", "0", "false"]) expect(evaluate(`!${falsy}`, ctx)).toBe(true);
    expect(evaluate("!'x'", ctx)).toBe(false);
  });

  test("an operator or bracket inside a string literal is text, not syntax", () => {
    expect(evaluate("'!'", ctx)).toBe("!");
    expect(evaluate("contains(')', 'x')", ctx)).toBe(false);
    expect(evaluate("format('{0}', '(')", ctx)).toBe("(");
    expect(evaluate("'a' == '&&'", ctx)).toBe(false);
    expect(evaluate("!false", ctx)).toBe(true);
  });

  test("&& and || do not evaluate the operand they skip, and do evaluate the one they return", () => {
    expect(evaluate("false && fromJSON('')", ctx)).toBe(false);
    expect(evaluate("true || fromJSON('')", ctx)).toBe(true);
    expect(evaluate("true && fromJSON('[1]')", ctx)).toEqual([1]);
    expect(evaluate("false || fromJSON('[1]')", ctx)).toEqual([1]);
    expect(() => evaluate("true && fromJSON('')", ctx)).toThrow();
  });

  test("an absent property is null and a hyphenated step id resolves", () => {
    expect(evaluate("github.event.missing.deeper", ctx)).toBeNull();
    expect(evaluate("steps.queued-pr.outputs.login", ctx)).toBe("renovate[bot]");
    expect(evaluate("steps['queued-pr'].outputs.login", ctx)).toBe("renovate[bot]");
  });
});

describe("functions", () => {
  test("startsWith, contains, format and fromJSON", () => {
    expect(evaluate("startsWith('release/v1', 'release/v')", ctx)).toBe(true);
    expect(evaluate("startsWith(github.head_ref, 'release/v')", ctx)).toBe(false);
    expect(evaluate("contains(fromJSON('[\"22\", \"24\"]'), '24')", ctx)).toBe(true);
    expect(evaluate("format('pr-{0}-{1}', 7, 'x')", ctx)).toBe("pr-7-x");
    expect(evaluate("fromJSON('[\"22\", \"24\", \"26\"]')", ctx)).toEqual(["22", "24", "26"]);
  });

  test("status functions read the needed jobs' results", () => {
    expect(evaluate("always()", ctx)).toBe(true);
    expect(evaluate("success()", ctx)).toBe(true);
    expect(evaluate("failure()", ctx)).toBe(false);
    expect(evaluate("cancelled()", ctx)).toBe(false);
    const failed = { ...ctx, needs: { build: { result: "success" }, lint: { result: "failure" } } };
    expect(evaluate("always()", failed)).toBe(true);
    expect(evaluate("success()", failed)).toBe(false);
    expect(evaluate("failure()", failed)).toBe(true);
    const cancelled = { ...ctx, needs: { build: { result: "cancelled" } } };
    expect(evaluate("cancelled()", cancelled)).toBe(true);
    expect(evaluate("success()", { ...ctx, needs: { build: { result: "skipped" } } })).toBe(false);
  });

  test("an unsupported construct throws when evaluated", () => {
    expect(() => evaluate("hashFiles('bun.lock')", ctx)).toThrow("unsupported function hashFiles()");
    expect(() => evaluate("1 < 2", ctx)).toThrow("unsupported character '<'");
    expect(() => evaluate("'open", ctx)).toThrow("unterminated string");
    expect(() => evaluate("(github.event_name", ctx)).toThrow("expected ')'");
  });
});

describe("workflow values and conditions", () => {
  test("a single ${{ }} yields its value; several interpolate as text", () => {
    expect(evaluateValue("${{ fromJSON('[\"22\"]') }}", ctx)).toEqual(["22"]);
    expect(evaluateValue("${{ github.event_name }}-${{ github.event.merge_group.base_sha }}", ctx)).toBe("merge_group-abc");
    expect(evaluateValue("plain text", ctx)).toBe("plain text");
  });

  test("an absent if: is success(), and a bare or wrapped if: evaluates to a boolean", () => {
    expect(evaluateIf(undefined, ctx)).toBe(true);
    expect(evaluateIf("github.event_name == 'merge_group'", ctx)).toBe(true);
    expect(evaluateIf("${{ github.event_name == 'pull_request' }}", ctx)).toBe(false);
    expect(evaluateIf("startsWith(github.head_ref, 'release/v')", ctx)).toBe(false);
  });

  test("a condition without a status function is skipped when a needed job failed; always() still runs", () => {
    const failed = { ...ctx, needs: { build: { result: "failure" } } };
    expect(evaluateIf(undefined, failed)).toBe(false);
    expect(evaluateIf("github.event_name == 'merge_group'", failed)).toBe(false);
    expect(evaluateIf("always()", failed)).toBe(true);
    expect(evaluateIf("${{ always() && github.event_name == 'merge_group' }}", failed)).toBe(true);
    expect(evaluateIf("failure()", failed)).toBe(true);
  });

  test("a status call in a skipped operand still counts as a status call", () => {
    const failed = { ...ctx, needs: { build: { result: "failure" } } };
    expect(evaluateIf("true || always()", failed)).toBe(true);
    expect(evaluateIf("true || github.event_name == 'merge_group'", failed)).toBe(false);
  });

  test("a status-function name inside a string literal is not a call", () => {
    const failed = { ...ctx, needs: { build: { result: "failure" } } };
    const passed = { ...ctx, github: { ...ctx.github, event_name: "always()" } };
    expect(evaluateIf("github.event_name == 'always()'", failed)).toBe(false);
    expect(evaluateIf("github.event_name == 'always()'", passed)).toBe(true);
    expect(evaluateIf("${{ contains('failure()', 'x') || github.event_name == 'merge_group' }}", failed)).toBe(false);
  });
});
