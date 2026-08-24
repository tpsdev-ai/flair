- **LongMemEval bench: a single run no longer reports `± 0.0%`** (flair#1376).
  The sample std returned `0` for `n < 2` and the report printed
  `66.0% ± 0.0%`, which reads as "we ran it repeatedly and it agreed perfectly"
  when it means "we never measured variance" — an absence rendered as the
  strongest possible claim, on the path a published number travels. `std()` now
  returns `null` when there is nothing to measure, each arm aggregate carries
  `varianceMeasured`, and the headline renders
  `66.0% (single run — variance unmeasured)`. Affects the bench harness only;
  no change to Flair itself.
