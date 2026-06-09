// Gemini client singleton. One instance per process — the SDK pools its
// own HTTP connections, so creating multiple clients just wastes memory.
//
// Lazy init so importing this module doesn't blow up at boot when the
// app is being typechecked or run in a context without GEMINI_API_KEY
// (e.g. local sandbox without the player's paid key wired in).
import { GoogleGenAI } from '@google/genai';

let _client: GoogleGenAI | undefined;

export function getGemini(): GoogleGenAI {
  if (!_client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not set. Stage 4 (transcription) requires the player\'s Gemini API key — add it to Dokploy env for the Barkeep service.'
      );
    }
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Throttling helpers — designed for the free-tier rate limit (5 RPM on
// gemini-2.5-flash). Paid tier is 2000 RPM so the spacing is negligible
// overhead there, but on free tier 7 parallel calls instantly 429.
// ---------------------------------------------------------------------------

/** Default RPM target. Override with GEMINI_RPM_LIMIT env if you have paid tier. */
function rpmLimit(): number {
  const fromEnv = Number(process.env.GEMINI_RPM_LIMIT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 5;
}

/** Spacing in ms between sequential calls, derived from the RPM target. */
function spacingMs(): number {
  return Math.ceil(60_000 / rpmLimit()) + 500; // small buffer
}

/**
 * Run a fixed list of async tasks one at a time with a configurable spacer
 * between each. Returns results in input order. We intentionally do NOT
 * parallelize — free-tier Gemini caps at 5 RPM and any concurrency burns
 * the budget instantly.
 */
export async function runSequentialThrottled<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const spacing = spacingMs();
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, spacing));
    results.push(await fn(items[i]!, i));
  }
  return results;
}

/**
 * Wrap a Gemini call to catch TRANSIENT failures and retry without
 * counting against the caller's own retry budget. Covers:
 *   - 429 RESOURCE_EXHAUSTED (rate limit / quota) → respects `retry in Ns`
 *   - 503 UNAVAILABLE (model overloaded) → exponential backoff
 *
 * Caps individual waits at 120s. If the error persists after maxRetries,
 * the original error is re-thrown so the caller can mark its own state.
 */
export async function withGeminiRateLimitRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      const msg = String(lastErr.message ?? '');
      const retryAfterMatch = msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
      const is429 = retryAfterMatch || /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg);
      const is503 = /\b503\b|UNAVAILABLE|experiencing high demand|model is overloaded/i.test(msg);
      if ((!is429 && !is503) || attempt >= maxRetries) throw lastErr;

      let waitSec: number;
      if (retryAfterMatch) {
        waitSec = Math.min(parseFloat(retryAfterMatch[1]!), 120);
      } else if (is503) {
        // Exponential backoff for overloaded model: 10s, 30s, 60s
        waitSec = Math.min(10 * Math.pow(3, attempt), 60);
      } else {
        waitSec = 30;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(waitSec * 1000)));
    }
  }
  throw lastErr ?? new Error('withGeminiRateLimitRetry: unreachable');
}
