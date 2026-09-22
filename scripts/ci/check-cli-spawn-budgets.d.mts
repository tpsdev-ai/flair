/**
 * Types for scripts/ci/check-cli-spawn-budgets.mjs (flair#1807's CLI-spawn
 * class gate). The matching primitives are imported by
 * test/unit/check-cli-spawn-budgets.test.ts, which type-checks under strict —
 * and an untyped `.mjs` import fails that check, so the exported surface the
 * test touches is declared here (the same shape as the other scripts/*.d.mts).
 */

/** True when `ch` is a JS identifier character — `[A-Za-z0-9_$]`. */
export function isIdentChar(ch: string): boolean;

/**
 * Index of the next occurrence of `id` in `text` at or after `from` that is a
 * WHOLE identifier — neither the character before it nor the one after it is an
 * identifier character. Returns -1 when there is none.
 */
export function findIdentifier(text: string, id: string, from?: number): number;

/**
 * `idx` points just past an identifier. True when the next non-whitespace
 * character in `text` is `(` — i.e. the identifier is called.
 */
export function identifierCallFollows(text: string, idx: number): boolean;
