/**
 * harper-freeze-clock.cjs — a test-only, opt-in frozen clock for a spawned
 * Harper (flair#2333 H9).
 *
 * The test passes `FLAIR_TEST_FROZEN_NOW` and this preload's `--require` in
 * `startHarper({ env })`, without changing the test process environment.
 * The flag is appended to `NODE_OPTIONS`. Inert when the variable is unset.
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
