/**
 * harper-freeze-clock.cjs — a test-only, opt-in frozen clock for a spawned
 * Harper (flair#2333 H9).
 *
 * Loaded into the Harper process with `--require` when the test sets
 * `FLAIR_TEST_FROZEN_NOW` (an epoch-ms integer or any `Date.parse`-able string)
 * and prepends this file's `--require` to `NODE_OPTIONS` before `startHarper`.
 * Inert when the variable is unset, so no other test is affected.
 *
 * WHY: the OrgEvent.post() default id used to embed the wall clock at
 * millisecond resolution only (`<authorId>-<ISO>`), so two events posted by one
 * author in the same millisecond shared one id and one was lost. A real-Harper
 * test for that needs two posts the server stamps with the SAME millisecond,
 * and a millisecond is far shorter than a request round-trip; a concurrent burst
 * only reaches it by luck (measured: ~3 ms between requests — no collision).
 * Freezing the process clock makes the same-millisecond case deterministic while
 * still exercising the real HTTP path and the real table.
 *
 * The test process keeps the real clock, so its Ed25519 request timestamps stay
 * within agent-auth's 30 s window of the frozen instant as long as the test
 * finishes in that window.
 */
"use strict";

const raw = process.env.FLAIR_TEST_FROZEN_NOW;
if (raw) {
  const ms = /^-?\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (Number.isFinite(ms)) {
    const RealDate = Date;
    // A stand-in that answers the wall clock with the frozen instant, and any
    // explicit-argument construction (new Date(value), Date.parse) with the real
    // implementation.
    const FrozenDate = function Date(...args) {
      if (!(this instanceof FrozenDate)) return new RealDate(ms).toString();
      return new RealDate(args.length === 0 ? ms : args[0], ...args.slice(1));
    };
    FrozenDate.now = () => ms;
    FrozenDate.parse = RealDate.parse;
    FrozenDate.UTC = RealDate.UTC;
    FrozenDate.prototype = RealDate.prototype;
    Object.setPrototypeOf(FrozenDate, RealDate);
    globalThis.Date = FrozenDate;
  }
}
