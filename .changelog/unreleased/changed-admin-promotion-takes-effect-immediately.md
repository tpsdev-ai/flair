- **A promotion or demotion applies on the principal's next request.** Admin
  lookups are cached for 60 seconds, so granting admin used to appear not to
  work for up to a minute — long enough to conclude the grant had failed and
  start changing other things. The write path now drops the cached set when it
  changes a principal, so the new status is in force immediately. The cache is
  per worker thread, so a grant applied on one thread can still take up to the
  same 60 seconds to be seen on another; the bound is unchanged.
