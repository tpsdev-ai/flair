- **check-dep-ages treats an unparseable publish time as a registry failure.** A
  publish time that is present but is not a parseable string — a non-string such
  as a JSON object or number, or a string that is not a valid date — now fails
  the gate the same way an unreachable registry does: it is reported under the
  registry-failure diagnostic, naming the dependency and version, and the gate
  exits 2 — unless a too-fresh dependency was also found, which takes precedence
  and exits 1. The value is never compared to the bake-time cutoff, and the
  failure is not retried.
