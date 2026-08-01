- **The admin Instance page now HTML-escapes `publicUrl` in the Endpoints table and Public URL card.**
  `FLAIR_PUBLIC_URL` is operator-set and not validated, and as of 0.34.0 the deploy step writes it
  into the component's `.env` — so a value that used to be typed at a prompt now arrives through a
  payload. The fix escapes on output at every interpolation site rather than sanitising the input,
  which is the wrong layer. An operator setting a hostile value on their own instance is attacking
  themselves; this is fixed because the shape is wrong and the input path widened, not because it
  represents a meaningful external threat (#1029).
