export const NON_CANONICAL_TARGETS = [
  ["http://LOCALHOST.:9926", "http://localhost.:9926"],
  ["http://[::ffff:127.0.0.1]:9926", "http://[::ffff:7f00:1]:9926"],
  ["http://[0:0:0:0:0:ffff:127.1.2.3]:9926", "http://[::ffff:7f01:203]:9926"],
  ["http://127.1:9926", "http://127.0.0.1:9926"],
  ["http://2130706433:9926", "http://127.0.0.1:9926"],
  ["http://0x7f.1:9926", "http://127.0.0.1:9926"],
  ["http://0177.0.0.1:9926", "http://127.0.0.1:9926"],
  ["http://[0:0:0:0:0:0:0:1]:9926", "http://[::1]:9926"],
  ["HTTP://LOCALHOST:80", "http://localhost"],
  ["http://localhost:9926/path", "http://localhost:9926"],
  ["http://localhost:9926?", "http://localhost:9926"],
  ["http://localhost:9926#", "http://localhost:9926"],
  ["http://user:secret@localhost:9926", "http://localhost:9926"],
  ["https://ACME.harperfabric.com:443", "https://acme.harperfabric.com"],
] as const;

export const UNSPECIFIED_TARGETS = ["http://0.0.0.0:9926", "http://[::]:9926"];
