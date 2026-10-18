- **Presence writes must name a non-empty target.** An administrator's PUT/PATCH
  with an empty-string body `id` and a keyless administrator DELETE get 400
  `presence_target_required` (#2639).
