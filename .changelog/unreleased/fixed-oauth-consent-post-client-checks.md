- **The OAuth consent form's POST applies the consent page's scope and client checks before it issues an authorization code.**
  An approve on `POST /OAuthAuthorize` now answers 400 `invalid_scope` for a scope
  the server does not advertise, then 400 `invalid_client` when no `OAuthClient`
  record exists for `client_id`: the same checks, order and bodies as
  `GET /OAuthAuthorize`. Both run before authentication, and nothing is stored on
  a refusal. A blank scope is stored as `memory:read`, the scope the consent page
  renders for it. A deny still answers the `access_denied` redirect and issues no
  code.
