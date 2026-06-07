// /whodunit — debugging helper.
//
// "Who played character X recently?" — returns the most recent SessionPlayer
// rows for the given character name (across any session of any campaign).
// Ephemeral — only the invoker sees the result.
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('whodunit')
  .setDescription('Show who played a given character recently')
  .addStringOption((o) =>
    o.setName('character').setDescription('Character name (exact, case-insensitive)').setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const prisma = getPrisma();
  const name = interaction.options.getString('character', true);

  const characters = await prisma.character.findMany({
    where: { name: { equals: name, mode: 'insensitive' } },
    include: { campaign: { select: { name: true } } }
  });
  if (characters.length === 0) {
    await interaction.reply({
      content: `No character named "${name}" exists.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const recentRows = await prisma.sessionPlayer.findMany({
    where: { characterId: { in: characters.map((c) => c.id) } },
    include: {
      user: { select: { displayName: true, discordUsername: true } },
      session: { select: { sessionNumber: true, startedAt: true } },
      character: { select: { name: true, campaign: { select: { name: true } } } }
    },
    orderBy: { session: { startedAt: 'desc' } },
    take: 10
  });

  const embed = new EmbedBuilder()
    .setTitle(`🎭 ${characters[0]!.name}`)
    .setColor(0xb87333);

  if (recentRows.length === 0) {
    embed.setDescription('Character exists but hasn\'t appeared in any recorded session yet.');
  } else {
    embed.setDescription(
      recentRows
        .map((r) => {
          const date = r.session.startedAt
            ? r.session.startedAt.toISOString().slice(0, 10)
            : '?';
          const camp = r.character?.campaign.name ?? '?';
          return `**${date}** — ${camp} #${r.session.sessionNumber ?? '?'} — ${r.user.displayName} (\`${r.user.discordUsername}\`)`;
        })
        .join('\n')
    );
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
