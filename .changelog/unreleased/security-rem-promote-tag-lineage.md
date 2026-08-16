- **`flair rem promote` now preserves the source scope tag and fails closed
  for ADK-sourced candidates.** Promotion previously stamped only
  `nightly-rem-promoted` / `from:<id>` and dropped the candidate's source tag.
  For a candidate distilled from ADK session records (a source memory carries
  an `adk:<app>:<user>` tag), the promoted claim now carries that scope tag
  alongside the provenance tags. If such a candidate is ADK-sourced but its
  scope tag cannot be uniquely and completely determined (multiple distinct
  tags, or an unreadable source), or if it targets Soul (which is agent-scoped
  and cannot carry a per-user tag), promotion is refused rather than writing a
  claim that could leak across users. Non-ADK candidates promote exactly as
  before.
