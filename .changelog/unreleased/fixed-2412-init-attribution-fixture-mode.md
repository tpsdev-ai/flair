- **The supplied-credential cases in the isolated init admin-credential test no longer depend on the host umask.**
  The fixture wrote its PID file with the default create mode, so on a host whose
  umask left it group-writable init's own-PID-file proof refused it, and the cases
  failed their attribution step instead of reaching the supplied-credential code
  they assert on. The fixture now pins the PID file to 0600 (flair#2412).
