- **GitHub release notes now render a lede and links, not the full CHANGELOG.**
  The auto-cut GitHub release keeps each entry's bold lede, up to three issue
  links, and any `> **Heads-up:**` operator lines, then links the deep
  `CHANGELOG.md` at the tag. The record itself is unchanged in depth.

  > **Heads-up:** operator-critical detail that lives only in an entry body will
  > not appear on the release page. Put it in a `> **Heads-up:**` line. The
  > v0.49.0 credential note — *before this fix, `revoked` was not terminal* —
  > is why the convention exists (flair#1392).
