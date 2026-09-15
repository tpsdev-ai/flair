- **Flair releases now stop at a staged tag until a clean-machine canary installs and boots the published version.**

  Publishing a release no longer moves `latest`. The release pipeline stages the
  packages under a `staged` tag, a maintainer approves them with 2FA, and a job
  with no stored credentials then installs that exact version from the public
  registry on Linux and macOS and boots it — with install scripts on, exactly as a
  user's install runs. `latest` moves only after the canary passes, when the
  emitted checksum-bound promote command is run. If the canary fails, the release
  prints the command to deprecate the broken version and the next patch is cut; a
  staged version is never refreshed in place.

  > **Heads-up:** after approving a release, run the post-publish canary and paste
  > the command it prints. Until you do, `latest` still points at the previous
  > version.
