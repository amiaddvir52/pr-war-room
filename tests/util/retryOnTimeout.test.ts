import { describe, it, expect, vi } from "vitest";
import { retryOnTimeout } from "../../src/util/retryOnTimeout.js";
import { ReviewerError, ReviewerTimeoutError } from "../../src/errors.js";

describe("retryOnTimeout", () => {
  it("returns the value on first success without retrying", async () => {
    let calls = 0;
    const value = await retryOnTimeout(
      async () => {
        calls++;
        return "ok";
      },
      { timeoutMs: 1_000, retries: 2 },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a timed-out attempt and returns the retry's value", async () => {
    let calls = 0;
    const onTimeout = vi.fn();
    const value = await retryOnTimeout(
      async () => {
        calls++;
        // First attempt times out (throws the typed timeout); the retry succeeds.
        if (calls === 1) throw new ReviewerTimeoutError("timed out after 1000ms");
        return "recovered";
      },
      { timeoutMs: 1_000, retries: 1, onTimeout },
    );
    expect(value).toBe("recovered");
    expect(calls).toBe(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(1, expect.any(ReviewerTimeoutError));
  });

  it("rethrows the timeout after exhausting retries", async () => {
    let calls = 0;
    await expect(
      retryOnTimeout(
        async () => {
          calls++;
          throw new ReviewerTimeoutError("timed out after 1000ms");
        },
        { timeoutMs: 1_000, retries: 2 },
      ),
    ).rejects.toBeInstanceOf(ReviewerTimeoutError);
    // Initial attempt + 2 retries.
    expect(calls).toBe(3);
  });

  it("does NOT retry a non-timeout error (deterministic failure)", async () => {
    let calls = 0;
    await expect(
      retryOnTimeout(
        async () => {
          calls++;
          throw new ReviewerError("model refused");
        },
        { timeoutMs: 1_000, retries: 3 },
      ),
    ).rejects.toBeInstanceOf(ReviewerError);
    expect(calls).toBe(1);
  });

  it("retries: 0 means a single attempt", async () => {
    let calls = 0;
    await expect(
      retryOnTimeout(
        async () => {
          calls++;
          throw new ReviewerTimeoutError("timed out");
        },
        { timeoutMs: 1_000, retries: 0 },
      ),
    ).rejects.toBeInstanceOf(ReviewerTimeoutError);
    expect(calls).toBe(1);
  });

  it("enforces its own timeout backstop on a hung attempt (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const promise = retryOnTimeout(
        () => {
          calls++;
          return new Promise<string>(() => {}); // never resolves
        },
        { timeoutMs: 1_000, retries: 1 },
      );
      // Attach a rejection handler up front so the eventual rejection is observed
      // (avoids an unhandled rejection when the second attempt's backstop fires).
      const settled = promise.then(
        () => "resolved",
        (e) => e,
      );
      // Advance through both attempts' (timeoutMs + grace) backstops.
      await vi.advanceTimersByTimeAsync((1_000 + 250) * 2 + 10);
      const result = await settled;
      expect(result).toBeInstanceOf(ReviewerTimeoutError);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
