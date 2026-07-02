/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the result array. Shared by the reviewer fan-out (`runReviewers`) and the
 * dedup adjudicator (`clusterFindings`) so both bound their concurrent model
 * calls the same way. Pure control-flow — no IO of its own.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
