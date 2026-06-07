// /recap — public command, show a past session's short summary.
//
// Default behavior: show the most recent session for the campaign tied to
// the channel where /recap was run. If that channel isn't a campaign
// channel, reply with a helpful "this channel isn't a campaign" message.
//
// Optional override:
//   /recap session_number:5         (in a campaign channel — pick a specific session)
//   /recap campaign:Drakar          (anywhere — explicit campaign)
//   /recap campaign:Drakar session_number:5
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('recap')
  .setDescription('Show the short recap for a past session')
  .addStringOption((o) =>
    o
      .setName('campaign')
      .setDescription('Campaign name (defaults to this channel\'s campaign)')
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addIntegerOption((o) =>
    o
      .setName('session_number')
      .setDescription('Specific session number (defaults to the most recent)')
      .setRequired(false)
      .setMinValue(1)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const prisma = getPrisma();
  const campaignNameInput = interaction.options.getString('campaign', false);
  const sessionNumber = interaction.options.getInteger('session_number', false);

  // 1. Resolve campaign — either from explicit option or the channel.
  let campaign:
    | { id: string; name: string; discordTextChannelId: string }
    | null = null;

  if (campaignNameInput) {
    campaign = await prisma.campaign.findFirst({
      where: { name: campaignNameInput, active: true },
      select: { id: true, name: true, discordTextChannelId: true }
    });
    if (!campaign) {
      await interaction.reply({
        content: `No active campaign named "${campaignNameInput}".`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  } else {
    if (!interaction.channelId) {
      await interaction.reply({
        content: 'Run this from a campaign channel, or pass `campaign:` explicitly.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    campaign = await prisma.campaign.findUnique({
      where: { discordTextChannelId: interaction.channelId },
      select: { id: true, name: true, discordTextChannelId: true }
    });
    if (!campaign) {
      await interaction.reply({
        content:
          'This channel isn\'t mapped to a campaign. Use the `campaign:` option to pick one.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  }

  // 2. Resolve session.
  const session = sessionNumber
    ? await prisma.session.findFirst({
        where: { campaignId: campaign.id, sessionNumber },
        include: { summary: true }
      })
    : await prisma.session.findFirst({
        where: {
          campaignId: campaign.id,
          summary: { isNot: null }
        },
        orderBy: { sessionNumber: 'desc' },
        include: { summary: true }
      });

  if (!session || !session.summary) {
    await interaction.reply({
      content: sessionNumber
        ? `No summary found for ${campaign.name} session #${sessionNumber}.`
        : `No summarized sessions yet for ${campaign.name}.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`📜 ${campaign.name} — Session ${session.sessionNumber ?? '?'}`)
    .setDescription(session.summary.short)
    .setColor(0xb87333)
    .setFooter({
      text:
        session.startedAt &&
        `Recorded ${session.startedAt.toISOString().slice(0, 10)}`
    });

  // Public — anyone in the channel can see it.
  await interaction.reply({ embeds: [embed] });
}

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
  await interaction.respond(
    campaigns
      .filter((c) => c.name.toLowerCase().includes(q))
      .map((c) => ({ name: c.name, value: c.name }))
  );
}
