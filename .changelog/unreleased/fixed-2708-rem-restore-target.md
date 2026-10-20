- **`flair rem restore --apply` lists candidates through the operations API on its target's host, after a preflight check of that pair.** For a loopback target URL (`localhost` or `[::1]` included) that operations API is reached on 127.0.0.1.

  The writes go to `FLAIR_URL`, or to the local instance when it is unset. The
  candidate listing goes to the operations API on that same host, at
  `FLAIR_OPS_PORT` when it is set and otherwise at the port derived from
  `FLAIR_URL`; a target URL without a port has HTTP port 80 or 443. Before any
  listing, delete or write, restore runs a preflight check of the pair and
  refuses when it does not pass. Which check runs depends on the target URL,
  not on where the instance runs. With no `FLAIR_URL`, or a loopback URL
  (`127.0.0.1`, `localhost` or `[::1]`), the operations API's configuration
  must record the target's HTTP port and the OS listener table must show one
  process with a Harper command line listening on both ports; a port pair that
  conflicts with this host's configured pair is also refused. With any other
  URL, including one with this machine's LAN address, the HTTP endpoint and the
  operations endpoint must each report exactly one `flair.Instance` row with
  the same id; a missing, unreadable or redirected identity read refuses. The
  check covers the endpoints as they answer it, not a process that takes one
  over after it passes. Restore's REST calls do not follow redirects, and each
  Memory, Soul and candidate read, delete and write of a live replay carries
  the admin credential restore resolved (`--admin-pass`, `--admin-pass-file`, or the
  default), so no local admin-password file is needed when a flag gives one. A
  `FLAIR_OPS_TARGET` does not select the listing endpoint: restore refuses
  while it is set to anything but that endpoint's root URL, a value of only
  whitespace included (an empty value counts as unset). Restore refuses a
  target URL that carries user info, a query or a fragment, printing none of
  their values (#2708).

  > **Heads-up:** restore now refuses while `FLAIR_OPS_TARGET` is set to
  > anything but its target's operations root URL; unset it for the restore. A
  > restore with a non-loopback `FLAIR_URL` needs both endpoints to report the
  > same `flair.Instance` id. For the listener check instead, run the restore
  > on the instance's own host with `FLAIR_URL` unset or set to the instance's
  > loopback URL. An authorized, successful `GET /FederationInstance` (admin
  > credential; `flair federation status --target <url>` sends it) creates the
  > Instance row when there is none; it can refuse, for example when the
  > Instance table cannot be read or the row cannot be created, and any refusal
  > has to be resolved first.
