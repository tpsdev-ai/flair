- **The `doctor` and `init` probe tests give the same result on every machine.** They now point the key lookup at their own temporary directory instead of the real `~/.flair/keys`, so a release host with a real agent key behaves exactly like CI.

  This is test-only: no runtime behaviour changes. Previously the tests passed in CI (which has no real keys) but could fail on a host where a real key outranked the test's temporary one, blocking the release.
