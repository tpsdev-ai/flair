- **`flair init` validates the launchd plist it writes when there is no legacy job to migrate (Closes #2085).**

  A plist that fails validation — including a lint that throws — is put back as
  it was, or removed when init created it, and the refusal is reported. A
  put-back that fails is reported and init exits 1.
