/**
 * rpcRetry.ts
 *
 * Tiny retry wrapper for transient public-RPC failures (HTTP 429 from
 * rate-limited gateways, socket resets, gateway timeouts). Used by the
 * deploy tasks so a transient blip mid-deploy doesn't abort the whole
 * multi-chain run.
 *
 * Design notes:
 *   - We classify errors conservatively: only obviously-transient signals
 *     trigger retries. Anything else (revert, bad nonce, wrong chain, etc.)
 *     fails fast so the operator sees the real problem.
 *   - Submission of an *unsigned* tx vs. waiting for a receipt are
 *     separated by the caller: we retry the submission (safe because the
 *     tx hasn't entered the mempool yet) and we retry the wait (pure
 *     read), but never retry "send + wait" as a single unit (could
 *     double-submit).
 *   - Backoff is exponential starting at 2s: 2s, 4s, 8s, 16s, 32s.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect transient RPC errors that are worth retrying. Common offenders on
 * public BSC / Polygon / Avalanche endpoints: HTTP 429 from upstream rate
 * limiters (api.zan.top, etc.), transient socket resets, and gateway
 * timeouts. Anything else (revert, nonce conflict, bad network, etc.)
 * should fail fast.
 */
export function isTransientRpcError(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as { message?: string })?.message ?? err);
  return (
    /429|Too Many Requests|rate limit/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH/i.test(msg) ||
    /socket hang up|network error|gateway timeout|503|502|504/i.test(msg)
  );
}

/**
 * Retry an async operation on transient RPC errors with exponential backoff.
 * Non-transient errors are re-thrown immediately.
 *
 * @param fn          the operation to attempt
 * @param label       human-readable label for log lines
 * @param maxAttempts total attempts including the first try (default 5)
 * @param baseDelayMs starting backoff in ms (default 2000 -> 2s, 4s, 8s, 16s, 32s)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number = 5,
  baseDelayMs: number = 2_000,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || attempt === maxAttempts) {
        throw err;
      }
      const delay = baseDelayMs * 2 ** (attempt - 1);
      const errMsg = String((err as { message?: string })?.message ?? err);
      console.warn(
        `⚠ ${label}: transient RPC error on attempt ${attempt}/${maxAttempts} ` +
          `(${errMsg.slice(0, 80)}). Retrying in ${delay / 1000}s...`,
      );
      await sleep(delay);
    }
  }
  // Unreachable, but TypeScript can't prove it.
  throw lastErr;
}
