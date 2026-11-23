- **Targetless Presence PUT/PATCH and DELETE are refused.** An administrator's keyless
  PUT/PATCH with body `id: ""` and no other usable target, or keyless DELETE,
  gets 400 `presence_target_required` (#2639). ([#2640](https://github.com/tpsdev-ai/flair/pull/2640))
