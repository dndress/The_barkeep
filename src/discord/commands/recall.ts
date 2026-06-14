// /recall — admin-only on-demand summary fetch.
//
// Lets the admin pull a session's `short` or `full` summary into a DM
// without SSHing into the VPS / hitting psql.
//
// Options:
//   kind:     required. "short" → embed in DM. "full" → markdown attachment.
//   session:  optional. Session number; defaults to the latest summarized
//             session in the resolved campaign.
//   campaign: optional. Name; autocompleted. If omitted and the command is
//             invoked in a campaign channel, that channel's campaign is used.
//
// Why DM (not ephemeral): the full summary is ~8-15k chars (>>4096 embed
// cap). We attach it as a .md file. Short fits in an embed and is delivered
// the same way for consistency.
//
// Output channel: always DM the invoker. Reply ephemeral with a confirm
// or an error if DMs are closed.
import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('recall')
  .setDescription('DM yourself a session summary (admin only)')
  .addStringOption((o) =>
    o
      .setName('kind')
      .setDescription('Which summary to send')
      .setRequired(true)
      .addChoices(
        { name: 'short (embed)', value: 'short' },
        { name: 'full (markdown attachment)', value: 'full' }
      )
  )
  .addIntegerOption((o) =>
    o
      .setName('session')
      .setDescription('Session number (defaults to latest summarized)')
      .setRequired(false)
      .setMinValue(1)
  )
  .addStringOption((o) =>
    o
      .setName('campaign')
      .setDescription('Campaign name (defaults to this channel\'s campaign)')
      .setRequired(false)
      .setAutocomplete(true)
  );

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'campaign';
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return 'unknown-date';
  return d.toISOString().slice(0, 10);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // 1. Admin gate.
  const adminId = process.env.ADMIN_DISCORD_USER_ID;
  if (!adminId || interaction.user.id !== adminId) {
    await interaction.reply({
      content: 'This command is admin-only.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const kind = interaction.options.getString('kind', true) as 'short' | 'full';
  const sessionNumber = interaction.options.getInteger('session', false);
  const campaignName = interaction.options.getString('campaign', false);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const prisma = getPrisma();

  // 2. Resolve campaign: explicit arg > channel mapping.
  let campaignId: string | null = null;
  let resolvedCampaignName = '';

  if (campaignName) {
    const c = await prisma.campaign.findFirst({
      where: {
        name: campaignName,
        ...(interaction.guildId ? { discordGuildId: interaction.guildId } : {})
      },
      select: { id: true, name: true }
    });
    if (!c) {
      await interaction.editReply(`No campaign named "${campaignName}" in this guild.`);
      return;
    }
    campaignId = c.id;
    resolvedCampaignName = c.name;
  } else if (interaction.channelId) {
    const c = await prisma.campaign.findUnique({
      where: { discordTextChannelId: interaction.channelId },
      select: { id: true, name: true }
    });
    if (c) {
      campaignId = c.id;
      resolvedCampaignName = c.name;
    }
  }

  if (!campaignId) {
    await interaction.editReply(
      'No campaign resolved. Either run /recall from a campaign channel, or pass the `campaign` option.'
    );
    return;
  }

  // 3. Resolve session: explicit number > latest summarized.
  const session = await prisma.session.findFirst({
    where: {
      campaignId,
      ...(sessionNumber != null ? { sessionNumber } : {}),
      summary: { isNot: null }
    },
    orderBy: { sessionNumber: 'desc' },
    select: {
      id: true,
      sessionNumber: true,
      startedAt: true,
      summary: { select: { short: true, full: true, generatedAt: true } }
    }
  });

  if (!session || !session.summary) {
    const which = sessionNumber != null ? `session ${sessionNumber}` : 'any summarized session';
    await interaction.editReply(`No summary found for ${which} in **${resolvedCampaignName}**.`);
    return;
  }

  // 4. Open a DM channel up-front so we can detect closed DMs cleanly.
  let dm;
  try {
    dm = await interaction.user.createDM();
  } catch {
    await interaction.editReply(
      'Couldn\'t open a DM with you — check Privacy & Safety → "Direct Messages from server members".'
    );
    return;
  }

  const header = `${resolvedCampaignName} — Session ${session.sessionNumber ?? '?'}`;
  const subheader = `Played ${formatDate(session.startedAt)} · summary generated ${formatDate(session.summary.generatedAt)}`;

  try {
    if (kind === 'short') {
      // Short fits in an embed description (4096 char cap). Slice as a
      // safety net in case a model went long.
      const embed = new EmbedBuilder()
        .setTitle(header)
        .setDescription(session.summary.short.slice(0, 4000))
        .setColor(0xb87333)
        .setFooter({ text: subheader });
      await dm.send({ embeds: [embed] });
    } else {
      // Full: deliver as a Markdown attachment. No truncation, no chunking.
      const md =
        `# ${header}\n\n_${subheader}_\n\n---\n\n` +
        session.summary.full +
        '\n';
      const filename = `${slugify(resolvedCampaignName)}-S${session.sessionNumber ?? 'x'}-full.md`;
      const attachment = new AttachmentBuilder(Buffer.from(md, 'utf8'), { name: filename });
      await dm.send({
        content: `**${header}** — full summary attached.`,
        files: [attachment]
      });
    }
  } catch (err) {
    await interaction.editReply(
      `DM send failed: ${(err as Error).message ?? 'unknown error'}.`
    );
    return;
  }

  await interaction.editReply(
    `Sent the **${kind}** summary for **${resolvedCampaignName}** S${session.sessionNumber ?? '?'} to your DMs.`
  );
}

export async function autocomplete(
  interaction: import('discord.js').AutocompleteInteraction
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'campaign') return;
  const prisma = getPrisma();
  const guildId = interaction.guildId ?? undefined;
  const campaigns = await prisma.campaign.findMany({
    where: { ...(guildId ? { discordGuildId: guildId } : {}) },
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
