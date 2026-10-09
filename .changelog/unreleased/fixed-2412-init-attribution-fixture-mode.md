- **The isolated init admin-credential fixtures explicitly set the PID-file and open-mode saved-password permissions after creation.**
  The fixture wrote its PID file with the default create mode, so on a host whose
  umask left it group-writable init's own-PID-file proof refused it, and the cases
  failed their attribution step instead of reaching the supplied-credential code
  they assert on. The fixture now pins the PID file to 0600 and the open-mode
  saved-password fixture to 0644 (flair#2412).
