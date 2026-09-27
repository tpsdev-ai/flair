- **Flair's REST middleware allows `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH` and `DELETE` through its method check.**

  These methods proceed to the middleware's path and authentication handling.
  Every other method receives `405` with an `Allow` header listing the permitted
  methods before path or authentication handling. Separately mounted routes
  such as `/mcp` and OAuth discovery keep their own method handling.
