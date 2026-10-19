- **`flair rem restore --apply` lists candidates through the operations API on its target's host, after a preflight check of that pair.**

  The writes go to `FLAIR_URL`, or to the local instance when it is unset. The
  candidate listing goes to the operations API on that same host, at
  `FLAIR_OPS_PORT` when it is set and otherwise at the port derived from
  `FLAIR_URL`; a target URL without a port has HTTP port 80 or 443. Before any
  listing, delete or write, restore runs a preflight check of the pair and
  refuses when it does not pass. For a target on this host, the operations
  API's configuration must record the target's HTTP port and the OS listener
  table must show one process with a Harper command line listening on both
  ports; a port pair that conflicts with this host's configured pair is also
  refused. For a target on another host, the HTTP endpoint and the operations
  endpoint must each report exactly one `flair.Instance` row with the same id;
  a missing, unreadable or redirected identity read refuses. The check covers
  the endpoints as they answer it, not a process that takes one over after it
  passes. Restore's REST calls do not follow redirects. Restore never takes its
  listing endpoint from `FLAIR_OPS_TARGET`, refuses while it is set to anything
  but that endpoint's root URL, and refuses a target URL that carries user
  info, a query or a fragment, printing none of their values (#2708).

  > **Heads-up:** restore now refuses while `FLAIR_OPS_TARGET` is set to
  > anything but its target's operations root URL; unset it for the restore. A
  > restore against another host needs both endpoints to report the same
  > `flair.Instance` id. An instance gets that row from its first
  > `GET /FederationInstance` (sent by `flair federation status --target <url>`);
  > otherwise run the restore on the instance's own host.
