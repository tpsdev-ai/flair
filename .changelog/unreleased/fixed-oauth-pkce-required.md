- **The OAuth authorization endpoints and the authorization-code exchange require S256 PKCE; the discovery metadata lists S256 as the supported method.**
  After the earlier request, scope and client checks pass, `GET /OAuthAuthorize`
  and its Approve (`POST /OAuthAuthorize`) answer 400 `invalid_request` when
  `code_challenge` is missing, empty or not 43-128 base64url characters, or when
  `code_challenge_method` is not `S256`: the consent page is not rendered and no
  authorization code is stored. On the POST this check runs before
  authentication. A Deny still answers the `access_denied` redirect and issues
  no code. The authorization-code exchange at `POST /OAuthToken` redeems a code
  only with a `code_verifier` whose S256 hash matches the challenge stored with
  it. A code stored without an S256 challenge is `invalid_grant`; for an
  otherwise valid, unused code carrying an S256 challenge, a missing verifier is
  `invalid_request`.
