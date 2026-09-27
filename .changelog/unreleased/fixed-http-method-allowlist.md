- **Flair's HTTP layer accepts only the methods its clients use.**
  Requests with `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH` or `DELETE` are handled as before; any other method gets `405` with an `Allow` header, before any path or authentication branch, for every caller.
