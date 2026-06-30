// Per-campaign name-correction lexicon.
//
// When transcription mishears a proper noun ("Salat" → "Salad"), the admin
// adds an entry via /name-alias and future ingest passes auto-correct the
// text everywhere upstream of embedding: per-track transcripts, combined
// transcript, summarizer output (defensive).
//
// Design constraints:
//   - Empty alias list → identity function. Zero risk when no aliases exist.
//   - Word-boundary regex so the literal word "salad" in dialogue is left
//     alone if "Salad" is registered as wrong.
//   - Unicode-safe so accented names ("Andrés", "Cuervo") behave correctly.
//   - Order matters: longer `wrong` strings applied first to avoid the case
//     where one alias rewrites text in a way that makes the next alias miss.
//
// All exports are pure functions. The slash command + the ingest call sites
// own the I/O of loading aliases from the DB.

import type { PrismaClient } from '@prisma/client';

export interface NameAlias {
  /** Verbatim string to search for, case-sensitive. */
  wrong: string;
  /** Replacement string. */
  right: string;
}

/**
 * Load all aliases registered for `campaignId`, sorted longest-wrong first.
 *
 * Returns an empty array on:
 *   - `campaignId` null (caller hasn't resolved a campaign yet — typical
 *      for transcript ingest that runs before campaign detection finishes)
 *   - no rows in the table
 *
 * Either case means `applyAliases` is a no-op, so callers don't need to
 * branch on the result.
 */
export async function loadAliasesForCampaign(
  prisma: PrismaClient,
  campaignId: string | null | undefined
): Promise<NameAlias[]> {
  if (!campaignId) return [];
  const rows = await prisma.campaignNameAlias.findMany({
    where: { campaignId },
    select: { wrong: true, right: true }
  });
  return rows.sort((a, b) => b.wrong.length - a.wrong.length);
}

/**
 * Apply every alias to `text`, returning the rewritten string.
 *
 * Uses Unicode-aware word boundaries: `(?<![\p{L}\p{N}_])wrong(?![\p{L}\p{N}_])`.
 * Plain `\b` is ASCII-only and would mis-fire on accented characters.
 *
 * Each `wrong` is regex-escaped so it can contain dots, brackets, etc.
 * without surprises.
 *
 * Empty `aliases` → identity (returns `text` unchanged).
 */
export function applyAliases(text: string, aliases: NameAlias[]): string {
  if (!text || aliases.length === 0) return text;
  let out = text;
  for (const a of aliases) {
    if (!a.wrong) continue;
    const escaped = escapeRegex(a.wrong);
    // Unicode-aware boundary: lookbehind/ahead reject letters/digits/_ on
    // either side. This works for "Salat" inside "the Salat dragon" but
    // not inside "Salatic".
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
      'gu'
    );
    out = out.replace(re, a.right);
  }
  return out;
}

/**
 * Convenience: how many substitutions would `aliases` make in `text`?
 * Used by /name-alias apply-to-session to show the admin per-table counts
 * before the rewrite commits.
 */
export function countReplacements(text: string, aliases: NameAlias[]): number {
  if (!text || aliases.length === 0) return 0;
  let total = 0;
  for (const a of aliases) {
    if (!a.wrong) continue;
    const escaped = escapeRegex(a.wrong);
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
      'gu'
    );
    const matches = text.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

/**
 * Apply aliases to a JSON value recursively — walks objects and arrays,
 * rewriting every string leaf. Used to fix transcript `segments`, summary
 * `keyEvents`, etc. without round-tripping through `::text`.
 *
 * Safe for the JSON shapes we actually store: arrays of {start, text}
 * objects, nested key_events objects. Returns the same shape, with
 * strings rewritten in place where matches occur.
 */
export function applyAliasesToJson(
  value: unknown,
  aliases: NameAlias[]
): unknown {
  if (aliases.length === 0) return value;
  if (typeof value === 'string') return applyAliases(value, aliases);
  if (Array.isArray(value)) {
    return value.map((v) => applyAliasesToJson(v, aliases));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyAliasesToJson(v, aliases);
    }
    return out;
  }
  return value;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
