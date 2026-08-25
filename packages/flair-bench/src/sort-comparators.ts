/**
 * Generic total-order tail (flair#1412). Same helper as
 * `resources/sort-comparators.ts` — copied so this package stays
 * standalone (no flair install, no Harper). Cosine ranking keys on
 * corpus `.index`, not `.id`; force-fitting `byNumberDescThenId` here
 * would be the over-abstraction the #1412 spec names as the failure mode.
 *
 * Locale-independent code-unit / numeric comparison — not localeCompare.
 */
export function compareKey<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
