// /use-gemini-for — per-session override. Switches one session to use
// Gemini transcription regardless of the global default. Useful for
// rescuing a session that's been waiting on Whisper transcripts.
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('use-gemini-for')
  .setDescription('Override one session to use Gemini transcription instead of waiting on Whisper')
  .addStringOption((o) =>
    o.setName('session').setDescription('Session ID (UUID)').setRequired(true)
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
  const prisma = getPrisma();
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) {
    await interaction.reply({
      content: `No session with id \`${sessionId}\`.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  await prisma.session.update({
    where: { id: sessionId },
    data: { transcriptionSource: 'GEMINI' }
  });
  await interaction.reply({
    content: `✅ Session \`${sessionId.slice(0, 8)}…\` overridden to use Gemini. Worker will pick it up on the next tick.`,
    flags: MessageFlags.Ephemeral
  });
}
