// /tag-session — manually fix a NEEDS_REVIEW session.
//
// Usage:
//   /tag-session session:<uuid> campaign:<choice> dm:<@user, optional>
//
// Why this exists: when intro-extraction fails to detect campaign or DM,
// the bot DMs the admin with action buttons. This slash command is the
// fallback for when the original DM is buried, or when you want to fix
// something later from anywhere.
//
// Permission model: admin user only. We gate on Discord user ID rather
// than role/permission because Stage 6 doesn't model server admins yet —
// "admin" here means `ADMIN_DISCORD_USER_ID` (Andres).
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('tag-session')
  .setDescription('Manually assign campaign and DM for a session that needs review')
  .addStringOption((o) =>
    o.setName('session').setDescription('Session ID (UUID, copy from the review DM)').setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName('campaign')
      .setDescription('The campaign this session belongs to')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addUserOption((o) =>
    o.setName('dm').setDescription('Discord user who DMed this session (optional)').setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const adminId = process.env.ADMIN_DISCORD_USER_ID;
  if (!adminId || interaction.user.id !== adminId) {
    await interaction.reply({
      content: 'This command is admin-only.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const sessionId = interaction.options.getString('session', true);
  const campaignNameInput = interaction.options.getString('campaign', true);
  const dmUser = interaction.options.getUser('dm', false);

  const prisma = getPrisma();
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) {
    await interaction.reply({
      content: `No session found with id \`${sessionId}\`.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const campaign = await prisma.campaign.findFirst({
    where: { name: campaignNameInput, discordGuildId: session.discordGuildId },
    select: { id: true, name: true }
  });
  if (!campaign) {
    await interaction.reply({
      content: `No active campaign named "${campaignNameInput}" in this guild.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // If admin chose a DM, resolve it to our internal users.id.
  let dmUserDbId: string | null = session.dmUserId;
  if (dmUser) {
    const dmRow = await prisma.user.findUnique({ where: { discordUserId: dmUser.id } });
    if (!dmRow) {
      await interaction.reply({
        content: `That user (<@${dmUser.id}>) isn't seeded in the Barkeep users table.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    dmUserDbId = dmRow.id;
  }

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      campaignId: campaign.id,
      dmUserId: dmUserDbId,
      detectionMethod: 'MANUAL_TAG',
      status: 'SUMMARIZING',
      summarizeAttempts: 0,
      summarizeError: null
    }
  });

  await interaction.reply({
    content: `✅ Session \`${sessionId.slice(0, 8)}…\` tagged as **${campaign.name}**${dmUser ? ` with DM <@${dmUser.id}>` : ''}. The worker will reprocess it on the next tick.`,
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Autocomplete for the campaign option — returns the active campaigns in
 * the session's guild. Falls back to all active if no session focused.
 */
export async function autocomplete(
  interaction: import('discord.js').AutocompleteInteraction
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'campaign') return;
  const prisma = getPrisma();
  const guildId = interaction.guildId ?? undefined;
  const campaigns = await prisma.campaign.findMany({
    where: { active: true, ...(guildId ? { discordGuildId: guildId } : {}) },
    select: { name: true },
    take: 25
  });
  const q = focused.value.toLowerCase();
  const choices = campaigns
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((c) => ({ name: c.name, value: c.name }));
  await interaction.respond(choices);
}
