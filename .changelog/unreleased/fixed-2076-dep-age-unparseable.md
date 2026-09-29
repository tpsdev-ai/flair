- **check-dep-ages treats an unparseable publish time as a registry failure.** A
  publish time that is present but does not parse to a valid date now fails the
  gate the same way an unreachable registry does: it is reported under the
  registry-failure diagnostic, naming the dependency and version, and the gate
  exits 2. The value is never compared to the bake-time cutoff.
