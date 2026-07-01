import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../src/workspace/redact.js";

describe("redactSecrets", () => {
  it("redacts a known literal secret", () => {
    const out = redactSecrets("token is supersecretvalue123 here", ["supersecretvalue123"]);
    expect(out).not.toContain("supersecretvalue123");
    expect(out).toContain("***REDACTED***");
  });

  it("ignores short/empty extra secrets to avoid over-redaction", () => {
    expect(redactSecrets("abc def", ["ab", "", null, undefined])).toBe("abc def");
  });

  it("redacts GitHub token shapes", () => {
    const text = "gho_0123456789abcdef0123456789abcdef01 and github_pat_11ABCDEFG0123456789_abcdef";
    const out = redactSecrets(text);
    expect(out).not.toMatch(/gho_[A-Za-z0-9]{20,}/);
    expect(out).not.toMatch(/github_pat_/);
  });

  it("redacts credentials embedded in a URL but keeps the scheme", () => {
    const out = redactSecrets("cloning https://x-access-token:ghp_abcABC0123456789abcd@github.com/o/r.git");
    expect(out).toContain("https://***REDACTED***@github.com/o/r.git");
    expect(out).not.toContain("ghp_abcABC0123456789abcd");
  });

  it("redacts AWS keys and PEM private keys", () => {
    expect(redactSecrets("key AKIAIOSFODNN7EXAMPLE")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\nxyz\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`before ${pem} after`)).not.toContain("abc");
  });
});
