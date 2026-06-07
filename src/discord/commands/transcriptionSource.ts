// /transcription-source — flip the global default between Whisper-from-Drive
// and Gemini API. Admin only. Persisted in BotSettings.
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('transcription-source')
  .setDescription('Set the global default transcription source')
  .addStringOption((o) =>
    o
      .setName('value')
      .setDescription('Which source new sessions should use by default')
      .setRequired(true)
      .addChoices(
        { name: 'External Whisper (Drive)', value: 'external_whisper' },
        { name: 'Gemini API', value: 'gemini' }
      )
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
  const value = interaction.options.getString('value', true);
  const dbValue = value === 'gemini' ? 'GEMINI' : 'EXTERNAL_WHISPER';
  const prisma = getPrisma();
  await prisma.botSettings.upsert({
    where: { id: 1 },
    update: { transcriptionSource: dbValue },
    create: { id: 1, transcriptionSource: dbValue }
  });
  await interaction.reply({
    content: `✅ Global transcription source set to **${value}**. Existing sessions keep their current setting unless overridden.`,
    flags: MessageFlags.Ephemeral
  });
}
