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

// Discord embed limits we respect:
//   - field value:  1024 chars
//   - field count:  25 per embed
//   - total embed:  6000 chars (title + desc + all field names/values + footer)
const FIELD_VALUE_CAP = 1024;
const FIELD_NAME_PRIMARY = '✨ Eventos clave';
const FIELD_NAME_CONT = '✨ Eventos clave (cont.)';

function renderEventBullet(e: KeyEventLike): string {
  const who = e.characters_involved?.length
    ? ` _(${e.characters_involved.join(', ')})_`
    : '';
  return `• ${e.description}${who}`;
}

/**
 * Pack a list of pre-rendered bullets into Discord field values, each ≤ cap chars.
 * Splits only on bullet boundaries. A single oversize bullet is hard-truncated
 * with an ellipsis (last resort — shouldn't happen with current event sizes).
 */
function packBulletsIntoFields(bullets: string[], cap: number): string[] {
  const fields: string[] = [];
  let buf = '';
  for (const raw of bullets) {
    const bullet = raw.length > cap ? raw.slice(0, cap - 1) + '…' : raw;
    const sep = buf ? '\n' : '';
    if (buf.length + sep.length + bullet.length > cap) {
      if (buf) fields.push(buf);
      buf = bullet;
    } else {
      buf += sep + bullet;
    }
  }
  if (buf) fields.push(buf);
  return fields;
}

interface EventField {
  name: string;
  value: string;
}

/**
 * Build the embed fields for key events, respecting Discord limits.
 * Drops overflow bullets (least-important first, since input is importance-sorted desc)
 * and appends a "(+N más)" footer line when truncation occurs.
 *
 * @param remainingBudget total chars still available in the embed (6000 - already used).
 */
function buildKeyEventFields(
  events: KeyEventLike[],
  remainingBudget: number
): EventField[] {
  if (events.length === 0) {
    return [{ name: FIELD_NAME_PRIMARY, value: '_(none)_' }];
  }
  const sorted = [...events].sort((a, b) => b.importance - a.importance);

  // Try to fit all events; if we exceed budget or field count, drop the
  // lowest-importance tail until we fit, leaving room for a "(+N más)" note.
  for (let keep = sorted.length; keep >= 0; keep--) {
    const dropped = sorted.length - keep;
    const bullets = sorted.slice(0, keep).map(renderEventBullet);
    if (dropped > 0) bullets.push(`_(+${dropped} eventos más)_`);
    if (bullets.length === 0) {
      return [{ name: FIELD_NAME_PRIMARY, value: '_(none)_' }];
    }
    const packed = packBulletsIntoFields(bullets, FIELD_VALUE_CAP);
    // Cap field count at 24 (leave 1 slot of safety margin under Discord's 25).
    if (packed.length > 24) continue;

    const fields: EventField[] = packed.map((value, i) => ({
      name: i === 0 ? FIELD_NAME_PRIMARY : FIELD_NAME_CONT,
      value
    }));
    const totalCost = fields.reduce((s, f) => s + f.name.length + f.value.length, 0);
    if (totalCost <= remainingBudget) return fields;
  }
  return [{ name: FIELD_NAME_PRIMARY, value: '_(none)_' }];
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
    const title = `📜 ${session.campaign.name} — Session ${session.sessionNumber ?? '?'}`;
    const description = session.summary.short.slice(0, 4000);
    const footer = 'Pregúntame con /ask "..." (próximamente)';
    // Discord embed total cap = 6000. Subtract everything we know about
    // before sizing the events fields. Keep a 100-char safety margin.
    const remainingBudget = 6000 - title.length - description.length - footer.length - 100;
    const eventFields = buildKeyEventFields(events, remainingBudget);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(0xb87333)
      .addFields(eventFields)
      .setFooter({ text: footer });

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
