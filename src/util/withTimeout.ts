import { ReviewerTimeoutError } from "../errors.js";

/**
 * Grace added to a call's own timeout before this orchestrator backstop fires,
 * so a CLI backend's subprocess self-kill wins the race and no process is
 * orphaned. Shared by the reviewer fan-out and the skeptic.
 */
export const TIMEOUT_GRACE_MS = 250;

/**
 * Reject with a `ReviewerTimeoutError` if `promise` doesn't settle within `ms`.
 * The orchestrator backstop for any hung model call: the CLI backends also
 * self-kill their subprocess at their own timeout and throw the same typed
 * error, so `instanceof ReviewerTimeoutError` classifies a timeout regardless of
 * which fired first — no message-text matching. Shared by the reviewer fan-out
 * and the skeptic so both bound their calls the same way.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReviewerTimeoutError(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
