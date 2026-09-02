- **release.sh no longer embeds the GitHub token in the push URL (flair#955).** The
  release push authenticated with `https://x-access-token:<token>@github.com/...`, which
  places a live credential in argv — visible to `ps`, `set -x` traces, CI step logs and
  any transcript that captured the command. The push now supplies the token through a
  per-invocation git credential helper that reads it from the environment at call time,
  exported inside an untraced subshell. Proof in the PR: under `set -x` the trace
  contains zero occurrences of the token value; a `--dry-run` push against the real
  remote authenticates. Operator-facing behaviour is unchanged.
