- **An operator's collection DELETE on Integration now removes the matched
  rows.** Harper's bulk delete drives the resource's own `search()`
  synchronously, which this resource's async `search()` could not satisfy, so
  the request failed with a 500 and removed nothing. The delete now scans
  through this resource's search and deletes each matched row; a runtime
  principal's collection DELETE stays refused.
