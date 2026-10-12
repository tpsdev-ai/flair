- **Flair's auth middleware handles a `basic`- or `BASIC`-spelled Basic credential exactly like `Basic`.**

  Authentication scheme names are case-insensitive (RFC 9110). The `/FederationPair`
  public-bypass test and the Basic-auth branch now match the scheme case-insensitively,
  so a lower- or mixed-case Basic credential reaches the Basic branch instead of taking
  the public bypass. For an authenticated bootstrap Basic caller supplying a valid
  token, `FederationPair` compares the annotated caller with the token's bootstrap
  user and refuses a mismatch.
