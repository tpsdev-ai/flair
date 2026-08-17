- **LongMemEval `artifactHash` is now reproducible.** `buildArtifact` previously
  stamped `generatedAt` (wall clock) and `host` into the artifact before hashing,
  so two runs with identical config and numbers produced different hashes. The
  artifact is now partitioned into hashed content (`schema`, `validationSlice`,
  `configHash`, `config`, `runHashes`, `aggregate`, `gitCommit`) and unhashed
  provenance (`generatedAt`, `host`, `notice`, `artifactHash`); provenance is
  stamped after hashing and stripped before verification, so identical content
  hashes identically regardless of where or when it ran.
