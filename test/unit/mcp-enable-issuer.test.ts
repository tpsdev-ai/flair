import { expect, test } from "bun:test";
import { checkLocalOriginRefusal, isLocalOrigin } from "../../src/lib/mcp-enable.ts";

test.each([
  "https://[fc00::]", "https://[fd00::1]", "https://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
  "https://[fe80::1]", "https://[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
  "https://[::]", "https://[::1]", "https://[0:0:0:0:0:0:0:1]",
  "https://[::ffff:10.0.0.1]", "https://[::ffff:172.16.0.1]", "https://[::ffff:172.31.255.255]",
  "https://[::ffff:192.168.1.1]", "https://[::ffff:169.254.1.1]", "https://[::ffff:127.0.0.1]",
  "https://[::ffff:0.0.0.0]", "https://[0:0:0:0:0:ffff:c0a8:101]",
  "https://localhost.", "https://child.localhost.", "https://machine.local.",
  "https://0.0.0.1", "https://127.1", "https://0x7f000001",
])("issuer check rejects local hostname/IP literal %s", (issuer) => {
  expect(isLocalOrigin(issuer)).toBe(true);
  expect(checkLocalOriginRefusal(issuer)).toMatchObject({ refused: true, reason: "local" });
});

test.each([
  "https://[fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]", "https://[fe00::]",
  "https://[fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff]", "https://[fec0::]",
  "https://[2606:4700:4700::1111]", "https://[::ffff:8.8.8.8]", "https://[::ffff:172.15.255.255]",
  "https://[::ffff:172.32.0.1]", "https://[::ffff:169.255.1.1]", "https://[::ffff:192.169.1.1]",
  "https://localhost.example.com", "https://machine.local.example.com", "https://127.0.0.1.example.com",
])("issuer check passes unmatched hostname/IP literal %s", (issuer) => {
  expect(isLocalOrigin(issuer)).toBe(false);
  expect(checkLocalOriginRefusal(issuer)).toEqual({ refused: false });
});

test.each(["not a url", "https://[not-ipv6]", "https://", "mailto:operator@example.com"])(
  "issuer check names %s invalid, not local", (issuer) => {
    expect(isLocalOrigin(issuer)).toBe(false);
    expect(checkLocalOriginRefusal(issuer)).toEqual({
      refused: true, reason: "invalid", message: "Issuer refused: invalid URL.",
    });
  },
);
