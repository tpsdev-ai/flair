- **`provisionIdpIdentityMapping` sends its ops calls to the port the caller names; the hosted ops port is applied only to `hostedOrigin`.**
  A URL string in `opsPortOrUrl` is used with its own host and port. It used to
  be read as a served origin and sent to the hosted ops port on that host. A
  target the helper cannot read unambiguously is refused before any request, and
  the error names what it received and the accepted forms. `flair mcp enable`
  passes its instance URL as `hostedOrigin`, so its identity-mapping calls go to
  the same address as before. (Closes #2102)
