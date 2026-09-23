- **Spoke bring-up, presence, attention help, MCP paths, and federation sync now match the code.**
  A Harper Fabric hub has no shell: mint the pairing token with `--target` and `--ops-target` on the Fabric ops port ([#840](https://github.com/tpsdev-ai/flair/issues/840)).
  `GET /Presence` returns `flairVersion` and `harperVersion` as null for unverified readers on purpose, and the `presenceStatus` thresholds are written down ([#932](https://github.com/tpsdev-ai/flair/issues/932)).
  `flair attention --help` requires a `type:value` vocabulary string ([#995](https://github.com/tpsdev-ai/flair/issues/995)).
  A local MCP client uses the `npx` stdio adapter; native `/mcp` is the remote OAuth path ([#998](https://github.com/tpsdev-ai/flair/issues/998)).
  Federation push skips Memory rows whose visibility is exactly `private` ([#1149](https://github.com/tpsdev-ai/flair/issues/1149)).
