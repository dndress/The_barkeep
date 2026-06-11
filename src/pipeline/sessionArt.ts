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

import { getGemini } from './gemini.js';

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
  const involvedNames = new Set(
    (iconic.characters_involved ?? []).filter((n) => n !== 'DM')
  );
  const castLines: string[] = [];
  for (const sp of session.sessionPlayers) {
    if (!sp.character) continue;
    if (!involvedNames.has(sp.character.name)) continue;
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
  const promptParts = [
    `Cinematic high-fantasy illustration capturing the scene: ${iconic.description}.`,
    castLines.length > 0 ? `Featured cast: ${castLines.join('; ')}.` : '',
    `Style: dramatic oil-painting feel, rich shadows, warm and cool lighting balance, narrative composition, painterly brushwork.`,
    `Avoid: text, captions, watermarks, logos, modern objects, anachronisms, comic-book exaggeration, photorealism.`
  ];
  const imagePrompt = promptParts.filter(Boolean).join(' ');

  // 6. Call Imagen.
  const ai = getGemini();
  log.info(
    { sessionId, model: opts.model, promptChars: imagePrompt.length },
    'generating session art'
  );
  const response = (await Promise.race([
    ai.models.generateImages({
      model: opts.model,
      prompt: imagePrompt,
      config: {
        numberOfImages: 1,
        aspectRatio: '16:9'
      }
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`session art generation timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs
      )
    )
  ])) as { generatedImages?: Array<{ image?: { imageBytes?: string } }> };

  const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (!imageBytes) {
    throw new Error('session art: Imagen returned no image bytes');
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
