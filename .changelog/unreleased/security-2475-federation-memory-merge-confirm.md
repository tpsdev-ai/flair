- **The federation sync merge of a `Memory` row confirms the whole stored row before it writes.**

  A planned `Memory` merge write now compares the whole stored row against the
  row the merge read, as the merge already does for `Soul`, `Agent`,
  `Relationship` and `Message`. A stored row that changed in any field is
  skipped as `merge_target_changed`, so nothing is written. The final
  confirmation re-reads the committed row before the transaction commits; a
  change committed after that read is not seen (resources/write-back.ts).
