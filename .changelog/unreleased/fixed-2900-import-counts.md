- **`flair import` counts a row as imported only when its write returned a 2xx response.**
  A row whose write returns any other status, except the Soul scope-field refusal, is
  counted as failed and reported with its id, HTTP status and the server's error
  name; the run exits 1. The Soul scope-field refusal keeps its existing report.
  An unknown write outcome is reported and exits 3.
