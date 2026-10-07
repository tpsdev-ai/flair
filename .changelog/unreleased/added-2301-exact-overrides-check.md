- Check declared direct root override keys matching workspace dependencies,
  devDependencies or optionalDependencies in CI and staged manifests in pre-commit.
  Accept exact semvers, exact npm: alias targets and workspace: specifiers.
  Workspace packages' own ranges and peerDependencies are out of scope (flair#2301).
