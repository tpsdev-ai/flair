- **CLI-managed launchd starts write identity sidecars only for confirmed processes (flair#2411).**
  `flair start` and the start leg of `flair restart` or `flair upgrade` write it only
  when launchd reports one stable pid, that pid is the sole port listener, Flair-shaped
  health answers, hdb.pid agrees, and its actual start time is readable. Unconfirmed starts warn
  and write no sidecar. A launchd KeepAlive relaunch through the launcher does
  not write a sidecar.
