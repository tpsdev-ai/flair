- **Pairing-token ids now reach every sweep and token log line only as their 8-character prefix, through one shared redactor.**

  The redaction is deep: a string field at any depth, an array element and an
  object KEY are all redacted, not only the message and its top-level string
  values. A token id shorter than 12 characters is replaced in full — a prefix
  that is most of the id is not a redaction — and every id the sweep has read in
  a pass joins the secret list, so a caller-supplied `consumedBy` or a Harper
  error that embeds a DIFFERENT token id is cut too. The sweep's two table-level
  error lines go through the same redactor.

  (Refs #1902)
