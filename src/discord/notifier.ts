// Discord notifications — Stage 6 version (full discord.js client).
//
// Two surfaces:
//   - notifyAdmin(message, context?) — drop a plain text DM to the admin.
//     Used for "summary failed N times", "cook errored unrecoverably", and
//     anything else where a free-text message is all we need.
//
//   - notifyAdminNeedsReview(sessionId, reason, campaigns) — drops a DM
//     with action buttons (one per campaign + a Skip). Used when intro
//     extraction couldn't pin down the campaign.
//
// Both gracefully no-op when discord isn't ready (logs warn, doesn't throw)
// so a Discord outage never breaks the pipeline.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type MessageCreateOptions
} from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

import { getDiscordClient, isDiscordReady } from './client.js';

export interface AdminMessageContext {
  [key: string]: unknown;
}

async function fetchAdmin(client: Client): Promise<import('discord.js').User | null> {
  const adminId = process.env.ADMIN_DISCORD_USER_ID;
  if (!adminId) return null;
  try {
    return await client.users.fetch(adminId);
  } catch (err) {
    return null;
  }
}

function buildContextBlock(context: AdminMessageContext | undefined): string {
  if (!context || Object.keys(context).length === 0) return '';
  const json = JSON.stringify(context, null, 2);
  // 2000-char message cap; leave headroom for the main message.
  const room = 1700;
  const trimmed = json.length > room ? json.slice(0, room - 3) + '...' : json;
  return `\n\`\`\`json\n${trimmed}\n\`\`\``;
}

export async function notifyAdmin(
  log: FastifyBaseLogger,
  message: string,
  context?: AdminMessageContext
): Promise<void> {
  if (!isDiscordReady()) {
    log.warn({ message }, 'notifyAdmin called but discord client isn\'t ready — skipping DM');
    return;
  }
  if (!process.env.ADMIN_DISCORD_USER_ID) {
    log.warn({ message }, 'ADMIN_DISCORD_USER_ID unset — skipping DM');
    return;
  }
  try {
    const client = getDiscordClient();
    const admin = await fetchAdmin(client);
    if (!admin) {
      log.warn('could not fetch admin user — skipping DM');
      return;
    }
    await admin.send({ content: (message + buildContextBlock(context)).slice(0, 2000) });
    log.info('admin DM sent');
  } catch (err) {
    log.error({ err }, 'failed to send admin DM');
  }
}

export interface NeedsReviewCampaignChoice {
  id: string;
  name: string;
}

/**
 * Send the admin a NEEDS_REVIEW DM with one button per campaign + Skip.
 * Discord caps a single row at 5 buttons — if there are more campaigns we
 * spill into a second row (cap 5 rows total).
 */
export async function notifyAdminNeedsReview(
  log: FastifyBaseLogger,
  sessionId: string,
  reason: string,
  campaigns: NeedsReviewCampaignChoice[]
): Promise<void> {
  if (!isDiscordReady()) {
    log.warn({ sessionId, reason }, 'notifyAdminNeedsReview: discord not ready, skipping DM');
    return;
  }
  try {
    const client = getDiscordClient();
    const admin = await fetchAdmin(client);
    if (!admin) {
      log.warn('could not fetch admin user — skipping NEEDS_REVIEW DM');
      return;
    }

    const buttons: ButtonBuilder[] = campaigns.slice(0, 24).map((c) =>
      new ButtonBuilder()
        // customId format: "nr:tag:<sessionId>:<campaignId>" — see needsReviewButtons.ts
        // Discord limits customId to 100 chars; UUIDs are 36 each, prefix is 7. Safe.
        .setCustomId(`nr:tag:${sessionId}:${c.id}`)
        .setLabel(c.name)
        .setStyle(ButtonStyle.Primary)
    );
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`nr:skip:${sessionId}`)
        .setLabel('Skip — handle later')
        .setStyle(ButtonStyle.Secondary)
    );

    // Discord: max 5 buttons per row, max 5 rows.
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
      if (rows.length === 5) break;
    }

    const content = [
      `🛠️ **Session needs review**`,
      ``,
      `**Reason:** ${reason}`,
      `**Session ID:** \`${sessionId}\``,
      ``,
      `Pick the campaign this session belongs to, or use \`/tag-session\` for finer control.`
    ].join('\n');

    const options: MessageCreateOptions = { content, components: rows };
    await admin.send(options);
    log.info({ sessionId, campaignChoices: campaigns.length }, 'needs-review DM sent with buttons');
  } catch (err) {
    log.error({ err, sessionId }, 'failed to send NEEDS_REVIEW DM');
  }
}
