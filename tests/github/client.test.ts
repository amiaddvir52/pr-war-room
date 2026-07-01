import { describe, it, expect } from "vitest";
import { createGitHubClient } from "../../src/github/client.js";
import { GitHubError } from "../../src/errors.js";
import { jsonResponse, textResponse, queuedFetch } from "./fakeFetch.js";

function client(fake: ReturnType<typeof queuedFetch>) {
  return createGitHubClient({
    token: "t",
    version: "9.9.9",
    fetchImpl: fake.impl,
    retryDelayMs: 0,
  });
}

describe("createGitHubClient", () => {
  it("sends the required headers", async () => {
    const fake = queuedFetch([() => Promise.resolve(jsonResponse({ ok: true }))]);
    await client(fake).getJson("/repos/o/r/pulls/1", "o/r#1");
    const headers = fake.calls[0]?.headers ?? {};
    expect(headers["authorization"]).toBe("Bearer t");
    expect(headers["user-agent"]).toBe("pr-war-room/9.9.9");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(headers["accept"]).toBe("application/vnd.github+json");
  });

  it("parses JSON on success", async () => {
    const fake = queuedFetch([() => Promise.resolve(jsonResponse({ title: "hi" }))]);
    await expect(client(fake).getJson("/x", "x")).resolves.toEqual({ title: "hi" });
  });

  it("maps 401 to an expired/scope message", async () => {
    const fake = queuedFetch([() => Promise.resolve(jsonResponse({}, { status: 401 }))]);
    await expect(client(fake).getJson("/x", "o/r#1")).rejects.toThrow(/401/);
  });

  it("maps 403 with remaining quota to a permission/scope message", async () => {
    const fake = queuedFetch([
      () =>
        Promise.resolve(
          jsonResponse({}, { status: 403, headers: { "x-ratelimit-remaining": "42" } }),
        ),
    ]);
    await expect(client(fake).getJson("/x", "o/r#1")).rejects.toThrow(/forbidden|permission|scope/i);
  });

  it("maps 403 with zero remaining to a rate-limit message", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const fake = queuedFetch([
      () =>
        Promise.resolve(
          jsonResponse(
            {},
            { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } },
          ),
        ),
    ]);
    await expect(client(fake).getJson("/x", "o/r#1")).rejects.toThrow(/rate limit/i);
  });

  it("maps 404 to a not-found/private-repo message", async () => {
    const fake = queuedFetch([() => Promise.resolve(jsonResponse({}, { status: 404 }))]);
    await expect(client(fake).getJson("/x", "o/r#1")).rejects.toThrow(/not found|private/i);
  });

  it("maps a non-JSON body to an unexpected-response error", async () => {
    const fake = queuedFetch([() => Promise.resolve(textResponse("<html>nope</html>"))]);
    await expect(client(fake).getJson("/x", "o/r#1")).rejects.toThrow(/unexpected/i);
  });

  it("maps a network failure to a reachability error", async () => {
    const fake = queuedFetch([
      () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })),
    ]);
    await expect(client(fake).getJson("/x", "o/r#1")).rejects.toThrow(/could not reach/i);
    expect(fake.calls).toHaveLength(2); // one retry
  });

  it("retries once on 5xx then succeeds", async () => {
    const fake = queuedFetch([
      () => Promise.resolve(jsonResponse({}, { status: 503 })),
      () => Promise.resolve(jsonResponse({ ok: true })),
    ]);
    await expect(client(fake).getJson("/x", "o/r#1")).resolves.toEqual({ ok: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("requestRaw returns the raw result without throwing on error status", async () => {
    const fake = queuedFetch([() => Promise.resolve(textResponse("body", { status: 406 }))]);
    const res = await client(fake).requestRaw("/x", "application/vnd.github.diff");
    expect(res.status).toBe(406);
    expect(res.ok).toBe(false);
    expect(res.body).toBe("body");
  });

  it("getJson is a GitHubError instance for HTTP failures", async () => {
    const fake = queuedFetch([() => Promise.resolve(jsonResponse({}, { status: 404 }))]);
    await expect(client(fake).getJson("/x", "o/r#1")).rejects.toBeInstanceOf(GitHubError);
  });
});
