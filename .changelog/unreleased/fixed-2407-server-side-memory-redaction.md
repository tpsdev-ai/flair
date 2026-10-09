- **Explicit memory writes redact credential-shaped text server-side, and the write response reports how many values were replaced.**
  The redactor automatic capture already uses is applied to `content`, `summary`
  and a skill row's `trigger` on every agent-authored Memory create and update,
  so credential-shaped text in those fields is stored only in redacted form.
  The write response carries a `redactedValues` count. A federated row is left
  as its origin wrote it: its per-record signature must keep verifying (flair#2407).
