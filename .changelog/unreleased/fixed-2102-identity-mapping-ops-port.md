- **`provisionIdpIdentityMapping` sends its ops calls to the port the caller names; the hosted ops port is applied only to `hostedOrigin`.**
  A URL string in `opsPortOrUrl` is used with its own host and port. A
  string target must exactly equal its parsed HTTP(S) origin or that origin plus
  `/`, with no credentials, non-root path, query or fragment. A target outside these
  forms is refused before any request; its error names the target field and
  shows only parsed scheme, hostname and port, without interpolating the raw
  input or displaying its userinfo, path, query or fragment. Parsed components
  can match part or all of the input. The display is `<unparseable value>` when
  the value is not a string, URL parsing fails, or the parsed URL has no hostname.
  `flair mcp enable`
  passes its instance URL as `hostedOrigin`, so its identity-mapping calls go to
  the same address as before. (Closes #2102)
