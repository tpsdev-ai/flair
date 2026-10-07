- **The unit lane checks wholly omitted packages with recognized test filenames and missing matrix shard indices.**
  The matrix check runs in the unsharded doclint job. Package discovery recognizes
  JS/TS and Python test filename patterns; other languages and omitted files
  inside planned packages are deferred.
