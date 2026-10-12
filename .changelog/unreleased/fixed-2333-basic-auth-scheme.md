- **A `basic`- or `BASIC`-spelled Basic credential is handled exactly like `Basic`.**

  Authentication scheme names are case-insensitive (RFC 9110). The `/FederationPair`
  public-bypass test and the Basic-auth branch now match the scheme case-insensitively,
  so a lower- or mixed-case Basic credential reaches the Basic branch — which binds a
  pairing token to its bootstrap user — instead of taking the public bypass.
