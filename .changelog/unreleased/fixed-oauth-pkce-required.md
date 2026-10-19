- **The OAuth authorization endpoints and token exchange require S256 PKCE, as the server's metadata advertises.**
  `GET /OAuthAuthorize` and its Approve (`POST /OAuthAuthorize`) answer 400
  `invalid_request` when `code_challenge` is missing, empty or not 43-128
  base64url characters, or when `code_challenge_method` is not `S256`: the
  consent page is not rendered and no authorization code is stored. These checks
  run after the scope and client checks and, on the POST, before
  authentication. A Deny still answers the `access_denied` redirect and issues
  no code. `POST /OAuthToken` exchanges a code only with a `code_verifier` whose
  S256 hash matches the challenge stored with it: a missing verifier is
  `invalid_request`, and a code stored without an S256 challenge is
  `invalid_grant`.
