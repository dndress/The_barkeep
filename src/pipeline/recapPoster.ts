// Stage 6 — Recap posting drain step.
//
// The worker calls postOneScheduledRecap() once per tick. It looks for a
// session that is:
//   - status = READY
//   - recap_scheduled_for <= NOW
//   - recap_posted_at IS NULL
//   - recap_post_attempts < cap
//   - campaignId set + summary exists (we wouldn't be READY otherwise, but
//     belt-and-braces)
//
// And posts an embed to that campaign's text channel via discord.js. If a
// session ArtPiece exists and its file is on disk, it's attached as the
// embed image. Missing art is silently skipped — never blocks the post.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db.js';
import { getDiscordClient, isDiscordReady } from '../discord/client.js';

export interface RecapPosterConfig {
  maxAttempts: number;
}

interface KeyEventLike {
  description: string;
  characters_involved: string[];
  importance: number;
}

function formatKeyEvents(events: KeyEventLike[]): string {
  if (events.length === 0) return '_(none)_';
  return events
    .slice(0, 8)
    .sort((a, b) => b.importance - a.importance)
    .map((e) => {
      const who = e.characters_involved?.length
        ? ` _(${e.characters_involved.join(', ')})_`
        : '';
      return `• ${e.description}${who}`;
    })
    .join('\n');
}

export async function postOneScheduledRecap(
  config: RecapPosterConfig,
  log: FastifyBaseLogger
): Promise<boolean> {
  if (!isDiscordReady()) {
    return false; // Quiet — we'll try next tick once discord is up
  }
  const prisma = getPrisma();
  const session = await prisma.session.findFirst({
    where: {
      status: 'READY',
      recapScheduledFor: { lte: new Date() },
      recapPostedAt: null,
      recapPostAttempts: { lt: config.maxAttempts },
      campaignId: { not: null }
    },
    orderBy: { recapScheduledFor: 'asc' },
    include: {
      summary: true,
      campaign: { select: { id: true, name: true, discordTextChannelId: true } },
      // Stage 9 — pick up the generated session art if one exists. We
      // ordered by createdAt so a regenerated row beats the original.
      artPieces: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });
  if (!session || !session.summary || !session.campaign) return false;

  log.info(
    {
      sessionId: session.id,
      campaign: session.campaign.name,
      sessionNumber: session.sessionNumber,
      channelId: session.campaign.discordTextChannelId
    },
    'posting recap'
  );

  try {
    const client = getDiscordClient();
    const channel = await client.channels.fetch(session.campaign.discordTextChannelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(
        `campaign.discordTextChannelId ${session.campaign.discordTextChannelId} is not a sendable text channel`
      );
    }

    const events = Array.isArray(session.summary.keyEvents)
      ? (session.summary.keyEvents as unknown as KeyEventLike[])
      : [];
    const embed = new EmbedBuilder()
      .setTitle(
        `📜 ${session.campaign.name} — Session ${session.sessionNumber ?? '?'}`
      )
      .setDescription(session.summary.short.slice(0, 4000))
      .setColor(0xb87333)
      .addFields({ name: '✨ Eventos clave', value: formatKeyEvents(events).slice(0, 1024) })
      .setFooter({ text: 'Pregúntame con /ask "..." (próximamente)' });

    // Stage 9 — if a session ArtPiece is on disk, attach it as the embed
    // image. Missing files are logged and skipped; never blocks the post.
    const artPiece = session.artPieces[0] ?? null;
    let attachment: AttachmentBuilder | null = null;
    let markArtPosted: string | null = null;
    if (artPiece?.filePath) {
      try {
        await fs.access(artPiece.filePath);
        const filename = path.basename(artPiece.filePath);
        attachment = new AttachmentBuilder(artPiece.filePath, { name: filename });
        embed.setImage(`attachment://${filename}`);
        markArtPosted = artPiece.id;
      } catch {
        log.warn(
          { sessionId: session.id, artPieceId: artPiece.id, filePath: artPiece.filePath },
          'session art file missing on disk — posting recap without image'
        );
      }
    }

    await channel.send(
      attachment ? { embeds: [embed], files: [attachment] } : { embeds: [embed] }
    );

    if (markArtPosted) {
      await prisma.artPiece.update({
        where: { id: markArtPosted },
        data: { posted: true }
      });
    }

    await prisma.session.update({
      where: { id: session.id },
      data: {
        recapPostedAt: new Date(),
        status: 'POSTED',
        recapPostError: null
      }
    });
    log.info({ sessionId: session.id }, 'recap posted');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, sessionId: session.id }, 'recap post failed');
    await prisma.session.update({
      where: { id: session.id },
      data: {
        recapPostAttempts: { increment: 1 },
        recapPostError: message.slice(0, 1000)
      }
    });
    return true; // still processed (consumed a tick slot)
  }
}
