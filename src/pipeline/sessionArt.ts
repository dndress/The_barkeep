// Stage 9 — Session art generation.
//
// One image per session, captured at the most iconic moment. Runs after
// summarization succeeds; the resulting ArtPiece row + file are picked up
// by the recap poster and attached to the Discord embed.
//
// Cost discipline:
//   - Idempotent. If an ArtPiece row already exists for the session, we
//     return it untouched. Summary retries never double-charge.
//   - Best-effort. Failures are logged and propagated, but the caller
//     should NOT block summary success on art generation.
import { promises as fs } from 'fs';
import path from 'path';

import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { getGemini, withGeminiRateLimitRetry } from './gemini.js';

// Hard ceiling on how many characters can appear in the generated image.
// Crowded compositions degrade Gemini Image faithfulness — 2–3 reads as a
// scene, 4+ degenerates into stylized blob crowds.
const MAX_FEATURED_CAST = 3;
// Model for the lightweight cast-picker call. Reuses the summarizer's text
// Flash model so we don't need a new env var. ~$0.0001 per call.
const CAST_PICKER_MODEL = process.env.SUMMARIZE_MODEL || 'gemini-2.5-flash';
const CAST_PICKER_TIMEOUT_MS = 20_000;

export interface SessionArtOptions {
  prisma: PrismaClient;
  sessionId: string;
  model: string;
  outputDir: string;
  timeoutMs: number;
  log: FastifyBaseLogger;
}

export interface SessionArtResult {
  artPieceId: string;
  filePath: string;
  prompt: string;
  reused: boolean;
}

interface KeyEventLike {
  description: string;
  characters_involved: string[];
  importance: number;
}

/**
 * Ask Gemini Flash to choose up to MAX_FEATURED_CAST names from `candidates`
 * that best represent the iconic moment visually. Returns a deduped,
 * order-preserving subset of `candidates` (never adds or invents names).
 *
 * Best-effort. On any error (timeout, parse failure, model returns garbage)
 * the caller falls back to the first MAX_FEATURED_CAST candidates.
 */
async function pickFeaturedCast(
  momentDescription: string,
  candidates: string[],
  log: FastifyBaseLogger
): Promise<string[] | null> {
  if (candidates.length === 0) return [];
  if (candidates.length <= MAX_FEATURED_CAST) return candidates;

  const prompt = [
    'You are choosing which characters to illustrate in a single composed scene.',
    `Pick at most ${MAX_FEATURED_CAST} characters from the CANDIDATES list whose presence is most visually central to the MOMENT. Prefer characters who act, are acted upon, or anchor the focal point. Drop bystanders, witnesses, off-camera contributors.`,
    'Rules:',
    `- Choose between 1 and ${MAX_FEATURED_CAST} names. Never invent names. Only return names exactly as they appear in CANDIDATES.`,
    '- Output ONLY a JSON array of strings. No prose, no markdown, no code fences.',
    '',
    `MOMENT: ${momentDescription}`,
    `CANDIDATES: ${JSON.stringify(candidates)}`
  ].join('\n');

  try {
    const ai = getGemini();
    interface TextPart { text?: string }
    interface TextResp { candidates?: Array<{ content?: { parts?: TextPart[] } }>; text?: string }
    const resp = (await Promise.race([
      withGeminiRateLimitRetry(() =>
        ai.models.generateContent({
          model: CAST_PICKER_MODEL,
          contents: prompt
        }) as Promise<TextResp>
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('cast picker timed out')),
          CAST_PICKER_TIMEOUT_MS
        )
      )
    ])) as TextResp;

    const raw =
      resp.text ??
      resp.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
      '';
    // Strip code fences if the model added them despite instructions.
    const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`no JSON array in response: ${raw.slice(0, 200)}`);
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error('response is not an array');

    const candidateSet = new Set(candidates);
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      // Only accept exact matches from the candidate list — guards against
      // hallucinated or paraphrased names.
      if (!candidateSet.has(item) || seen.has(item)) continue;
      seen.add(item);
      picked.push(item);
      if (picked.length >= MAX_FEATURED_CAST) break;
    }
    if (picked.length === 0) {
      throw new Error('picker returned 0 valid candidates after filtering');
    }
    return picked;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), candidates },
      'cast picker failed — falling back to first N candidates'
    );
    return null;
  }
}

/**
 * Generate (or reuse, if already present) the session art piece.
 *
 * Throws on hard errors (no summary, image API returned nothing). Caller
 * decides whether to swallow.
 */
export async function generateSessionArt(
  opts: SessionArtOptions
): Promise<SessionArtResult> {
  const { prisma, sessionId, log } = opts;

  // 1. Idempotency check — bail if we already produced one.
  const existing = await prisma.artPiece.findFirst({
    where: { sessionId },
    orderBy: { createdAt: 'asc' }
  });
  if (existing && existing.filePath) {
    // Verify the file is still on disk; if not, regenerate. This handles
    // the case where the volume was wiped between recap retries.
    try {
      await fs.stat(existing.filePath);
      log.info({ sessionId, artPieceId: existing.id }, 'session art already exists, reusing');
      return {
        artPieceId: existing.id,
        filePath: existing.filePath,
        prompt: existing.prompt,
        reused: true
      };
    } catch {
      log.warn(
        { sessionId, artPieceId: existing.id, filePath: existing.filePath },
        'ArtPiece row exists but file missing — regenerating'
      );
      // Fall through to regenerate; we'll update this row at the end.
    }
  }

  // 2. Load everything we need for the prompt.
  const session = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      summary: { select: { keyEvents: true, short: true } },
      campaign: { select: { name: true } },
      sessionPlayers: {
        include: {
          character: {
            select: {
              name: true,
              race: true,
              classOrRole: true,
              appearance: true
            }
          }
        }
      }
    }
  });

  if (!session.summary) {
    throw new Error('cannot generate session art: no summary persisted yet');
  }

  const events: KeyEventLike[] = Array.isArray(session.summary.keyEvents)
    ? (session.summary.keyEvents as unknown as KeyEventLike[])
    : [];
  if (events.length === 0) {
    throw new Error('cannot generate session art: summary has no key_events');
  }

  // 3. Pick the highest-importance event. Stable tie-breaker: original order.
  const iconic = [...events].sort((a, b) => b.importance - a.importance)[0];
  if (!iconic) {
    throw new Error('cannot generate session art: no iconic event after sort');
  }

  // 4. Build cast descriptions for characters present in the iconic moment.
  //    "DM" is filtered out (not a visual subject). Characters with an
  //    `appearance` field get their description woven in.
  //
  //    2026-06-28: cap the visual cast at MAX_FEATURED_CAST. Crowded scenes
  //    degrade Gemini Image faithfulness. When more than MAX_FEATURED_CAST
  //    characters are involved, ask a Flash text model to pick the most
  //    visually central ones — falls back to first-N on any failure.
  const allInvolved: string[] = (iconic.characters_involved ?? []).filter(
    (n) => n !== 'DM'
  );
  // Narrow candidates to characters we actually have on the roster (so the
  // picker can't be sent names with no `appearance` data to use).
  const rosterNames = new Set<string>();
  for (const sp of session.sessionPlayers) {
    if (sp.character) rosterNames.add(sp.character.name);
  }
  const candidates: string[] = allInvolved.filter((n) => rosterNames.has(n));

  let featured: string[];
  if (candidates.length <= MAX_FEATURED_CAST) {
    featured = candidates;
  } else {
    const picked = await pickFeaturedCast(iconic.description, candidates, log);
    featured = picked ?? candidates.slice(0, MAX_FEATURED_CAST);
    log.info(
      { sessionId, totalInvolved: candidates.length, featured, pickedByLLM: picked !== null },
      'limited featured cast for session art'
    );
  }
  const featuredSet = new Set(featured);

  const castLines: string[] = [];
  for (const sp of session.sessionPlayers) {
    if (!sp.character) continue;
    if (!featuredSet.has(sp.character.name)) continue;
    const parts: string[] = [sp.character.name];
    const kind = [sp.character.race, sp.character.classOrRole]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (kind) parts.push(`(${kind})`);
    if (sp.character.appearance) parts.push(`— ${sp.character.appearance}`);
    castLines.push(parts.join(' '));
  }

  // 5. Compose the image prompt. Style is opinionated and consistent so
  //    sessions feel like illustrations from one volume.
  const castCountClause =
    castLines.length > 0
      ? `Depict EXACTLY ${castLines.length} named character${castLines.length === 1 ? '' : 's'} as the visual subject${castLines.length === 1 ? '' : 's'} of the scene — no additional human figures, no background crowd, no extras beyond the listed cast.`
      : '';
  const promptParts = [
    `Cinematic high-fantasy illustration capturing the scene: ${iconic.description}.`,
    castLines.length > 0 ? `Featured cast: ${castLines.join('; ')}.` : '',
    castCountClause,
    `Style: dark fantasy horror graphic novel illustration, neo-noir lighting, heavy black ink shadows, sharp readable linework, high contrast, limited palette of deep blacks, cold teal-blue shadows, muted parchment tones, restrained crimson-orange supernatural glow, and occasional blue-white magical light. Ominous, nocturnal, serious, adult-targeted, story-driven. Strong silhouettes, dramatic single focal point, cinematic cropping, screenprint-like color blocking, controlled gritty texture.`,
    `Avoid: text, captions, watermarks, logos, modern objects, anachronisms, cute or comedic tone, anime style, photorealism, 3D-rendered look, glossy or overly clean fantasy art, muddy rendering, deep-fried texture, noisy grunge overlays, extra background characters or crowd figures beyond the named cast.`
  ];
  const imagePrompt = promptParts.filter(Boolean).join(' ');

  // 6. Call Gemini 2.5 Flash Image (Nano Banana) via generateContent.
  //    Migrated off Imagen 2026-06-13: Imagen models are deprecated and shut
  //    down on 2026-06-24, and Gemini Image's 32K-token prompt window means
  //    multi-PC scenes no longer risk silent prompt truncation.
  //    Response shape: candidates[0].content.parts[] — one part contains
  //    inlineData.data (base64 PNG) for the generated image, possibly with
  //    a text part alongside it. We pull the first inlineData payload.
  const ai = getGemini();
  log.info(
    { sessionId, model: opts.model, promptChars: imagePrompt.length },
    'generating session art'
  );

  interface GeminiImagePart {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
  }
  interface GeminiImageResponse {
    candidates?: Array<{
      content?: { parts?: GeminiImagePart[] };
    }>;
  }

  const response = (await Promise.race([
    ai.models.generateContent({
      model: opts.model,
      contents: imagePrompt,
      config: {
        // Gemini 2.5 Flash Image supports aspect ratios via imageConfig
        // (added when the model went GA in late 2025). Default is 1:1 if
        // omitted, so we set explicitly to keep recap embeds widescreen.
        imageConfig: { aspectRatio: '16:9' }
      }
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`session art generation timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs
      )
    )
  ])) as GeminiImageResponse;

  const imagePart = response.candidates?.[0]?.content?.parts?.find(
    (p) => Boolean(p.inlineData?.data)
  );
  const imageBytes = imagePart?.inlineData?.data;
  if (!imageBytes) {
    throw new Error('session art: Gemini returned no image bytes');
  }

  // 7. Persist to disk.
  await fs.mkdir(opts.outputDir, { recursive: true });
  const filePath = path.join(opts.outputDir, `${sessionId}.png`);
  await fs.writeFile(filePath, Buffer.from(imageBytes, 'base64'));

  // 8. Upsert the ArtPiece row. If we're regenerating after a file loss,
  //    keep the original row id so the recap poster sees a stable record.
  let artPieceId: string;
  if (existing) {
    await prisma.artPiece.update({
      where: { id: existing.id },
      data: { prompt: imagePrompt, filePath, posted: false }
    });
    artPieceId = existing.id;
  } else {
    const created = await prisma.artPiece.create({
      data: {
        sessionId,
        prompt: imagePrompt,
        filePath,
        posted: false
      }
    });
    artPieceId = created.id;
  }

  log.info({ sessionId, artPieceId, filePath }, 'session art generated');
  return { artPieceId, filePath, prompt: imagePrompt, reused: false };
}
