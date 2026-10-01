- **`provisionIdpIdentityMapping` sends its ops calls to the port the caller names; the hosted ops port is applied only to `hostedOrigin`.**
  A URL string in `opsPortOrUrl` is used with its own host and port. It used to
  be read as a served origin and sent to the hosted ops port on that host. A
  string target must exactly equal its parsed HTTP(S) origin or that origin plus
  `/`, with no credentials, non-root path, query or fragment. A target outside these
  forms is refused before any request; its error shows only parsed scheme,
  hostname and port, or a fixed placeholder if it cannot be parsed. `flair mcp enable`
  passes its instance URL as `hostedOrigin`, so its identity-mapping calls go to
  the same address as before. (Closes #2102)
