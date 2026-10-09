- **A Soul PATCH checks raw changes visible at its confirmation read.**
  A different or absent subject at confirmation is refused with
  `soul_patch_row_changed` (409); exhausted retries return `soul_patch_conflict`
  (409). A refused PATCH leaves the row and version history unchanged by that
  PATCH. Changes between confirmation and commit can still be overwritten:
  Harper has no compare-and-set.
