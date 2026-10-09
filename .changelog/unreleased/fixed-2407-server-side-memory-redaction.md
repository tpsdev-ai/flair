- **Memory writes redact recognized credential shapes server-side, and the write response reports how many values were replaced.**
  The redactor automatic capture already uses is applied to `content`,
  `summary` and `trigger` in the body of a Memory POST, PUT or PATCH and of
  `POST /FeedMemories`. Admin agent keys and OAuth principals are redacted too;
  the exception is the `flair init` seed's Basic-authenticated PUT of its
  reserved skill row, which stores the shipped text unchanged. When redaction
  changes `content` or `trigger`, a caller-supplied embedding is discarded.
  The write response carries `redactedValues`, the number of values replaced,
  when it is above zero; a deduplicated feed write reports it too. Incoming
  federated records are not redacted (flair#2407).
