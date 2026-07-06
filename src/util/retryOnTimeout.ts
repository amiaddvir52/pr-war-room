import { ReviewerTimeoutError } from "../errors.js";
import { TIMEOUT_GRACE_MS, withTimeout } from "./withTimeout.js";

/**
 * Run `attempt` under a per-attempt timeout, retrying up to `retries` extra
 * times when — and ONLY when — the attempt times out. Shared by the reviewer
 * fan-out, the skeptic, and the judge so all three treat a transient Claude CLI
 * timeout the same way: a single slow call should not silently remove a whole
 * reviewer angle or leave a cluster unvalidated when a re-run would have
 * succeeded.
 *
 * Only a `ReviewerTimeoutError` is retried. A refusal, parse failure, or hard
 * backend error is deterministic — re-running would just burn another call for
 * the same result — so those propagate immediately.
 *
 * Each attempt gets its own `timeoutMs + TIMEOUT_GRACE_MS` backstop (the CLI
 * backends self-kill their subprocess at `timeoutMs`; the grace lets that win
 * the race so no subprocess is orphaned — same contract as a bare
 * {@link withTimeout} call). `onTimeout` fires before each retry with the
 * 1-based number of the attempt that just timed out, so callers can surface the
 * retry. On exhaustion the last `ReviewerTimeoutError` is rethrown, so existing
 * `instanceof ReviewerTimeoutError` classification still works unchanged.
 *
 * Attempt COUNT is intentionally not returned: callers that need it increment a
 * counter inside their own `attempt` thunk, so the count is correct on both the
 * success and the throwing path without this helper having to thread it back.
 */
export async function retryOnTimeout<T>(
  attempt: () => Promise<T>,
  opts: {
    timeoutMs: number;
    retries: number;
    onTimeout?: (attemptNumber: number, err: ReviewerTimeoutError) => void;
  },
): Promise<T> {
  const max = Math.max(0, opts.retries);
  let lastTimeout: ReviewerTimeoutError | undefined;
  for (let i = 0; i <= max; i++) {
    try {
      return await withTimeout(attempt(), opts.timeoutMs + TIMEOUT_GRACE_MS);
    } catch (err) {
      if (err instanceof ReviewerTimeoutError && i < max) {
        lastTimeout = err;
        opts.onTimeout?.(i + 1, err);
        continue;
      }
      throw err;
    }
  }
  // Unreachable: the loop either returns a value or throws on its last iteration
  // (i === max). Kept so the function is total for the type checker.
  throw lastTimeout ?? new ReviewerTimeoutError("timed out");
}
