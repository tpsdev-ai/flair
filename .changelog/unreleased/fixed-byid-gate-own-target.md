- **The by-id read gate reads the full stored row through its own target.**
  For a non-admin by-id read, the shared gate loads the row for its read-scope decision with a target it builds itself, carrying only the id, rather than one derived from the caller's target. A caller-shaped result (a selection or a single property) is still returned only after that full row passes.
