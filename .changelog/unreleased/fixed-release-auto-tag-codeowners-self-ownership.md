- **The ownership map owns itself: `CODEOWNERS` is now owned by the repo admin.**
  The catch-all rule made the reviewers team the owner of `.github/CODEOWNERS`
  itself, so a collaborator with merge access and that team's approval could
  delete the `@heskew` entries — and then change the tagger, its workflow, its
  version checker or the advisory allowlist in a later pull request. The file now
  carries `/.github/CODEOWNERS @heskew`, below the catch-all, so changing who
  owns the trust root takes the same human as changing the trust root.
