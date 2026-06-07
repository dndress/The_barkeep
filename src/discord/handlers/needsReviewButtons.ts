// Handles button clicks on a "session needs review" DM.
//
// Button customId format (max 100 chars per Discord limits):
//   nr:tag:<sessionId>:<campaignId>     → tag session as this campaign
//   nr:skip:<sessionId>                  → just dismiss
//
// Why this format: discord.js stores customId on the button; we don't have
// a per-message state store. Encoding session + campaign IDs in the customId
// keeps the handler stateless.
import {
  ButtonInteraction,
  MessageFlags
} from 'discord.js';

import { getPrisma } from '../../db.js';

const PREFIX = 'nr:';

export function isNeedsReviewButton(customId: string): boolean {
  return customId.startsWith(PREFIX);
}

export async function handleNeedsReviewButton(interaction: ButtonInteraction): Promise<void> {
  const adminId = process.env.ADMIN_DISCORD_USER_ID;
  if (!adminId || interaction.user.id !== adminId) {
    await interaction.reply({
      content: 'These review buttons are admin-only.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const parts = interaction.customId.split(':');
  if (parts.length < 3) {
    await interaction.reply({
      content: 'Malformed review button.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const [, action, sessionId, campaignId] = parts;

  const prisma = getPrisma();
  const session = await prisma.session.findUnique({ where: { id: sessionId! } });
  if (!session) {
    await interaction.update({
      content: `Session \`${sessionId}\` not found in DB.`,
      components: []
    });
    return;
  }

  if (action === 'skip') {
    await interaction.update({
      content: `${interaction.message.content ?? ''}\n\n_Skipped — session remains \`needs_review\`._`,
      components: []
    });
    return;
  }

  if (action !== 'tag' || !campaignId) {
    await interaction.update({
      content: 'Unknown action.',
      components: []
    });
    return;
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true }
  });
  if (!campaign) {
    await interaction.update({
      content: `Campaign \`${campaignId}\` no longer exists.`,
      components: []
    });
    return;
  }

  await prisma.session.update({
    where: { id: sessionId! },
    data: {
      campaignId: campaign.id,
      detectionMethod: 'MANUAL_TAG',
      status: 'SUMMARIZING',
      summarizeAttempts: 0,
      summarizeError: null
    }
  });

  const original = interaction.message.content ?? '';
  await interaction.update({
    content: `${original}\n\n✅ **Tagged as ${campaign.name}** — re-running pipeline on next tick.`,
    components: []
  });
}
