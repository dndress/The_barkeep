// /check-drive — fire an immediate Drive poll without waiting for the
// regular interval. Replies ephemerally with a report.
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

import { pollDriveOnce } from '../../pipeline/driveIngest.js';
import { getPrisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('check-drive')
  .setDescription('Poll the Google Drive folder for new whisper transcripts right now');

interface CheckDriveDeps {
  log: FastifyBaseLogger;
  googleApiKey: string | undefined;
}

export function makeExecute(deps: CheckDriveDeps) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const adminId = process.env.ADMIN_DISCORD_USER_ID;
    if (!adminId || interaction.user.id !== adminId) {
      await interaction.reply({
        content: 'This command is admin-only.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (!deps.googleApiKey) {
      await interaction.reply({
        content: 'GOOGLE_API_KEY is not set on the bot — Drive ingest is disabled.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const prisma = getPrisma();
    const settings = await prisma.botSettings.findUnique({ where: { id: 1 } });
    if (!settings?.driveFolderId) {
      await interaction.reply({
        content: 'No Drive folder configured. Use `/drive-folder value:<url>` first.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // The poll can take several seconds — defer the reply.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const report = await pollDriveOnce(deps.googleApiKey, settings.driveFolderId, deps.log);
    await prisma.botSettings.update({
      where: { id: 1 },
      data: { driveLastPolledAt: new Date() }
    });

    const errors = report.errors.length ? `\nErrors: ${report.errors.slice(0, 3).join('; ')}` : '';
    await interaction.editReply({
      content: [
        `Drive poll complete.`,
        `• Subfolders inspected: **${report.subfoldersInspected}**`,
        `• Sessions touched: **${report.sessionsTouched}**`,
        `• Transcripts written: **${report.transcriptsWritten}**`,
        `• Info files ingested: **${report.infoFilesIngested}**`,
        `• Combined transcripts ingested: **${report.combinedIngested}**`,
        `• Files skipped: **${report.filesSkipped}**${errors}`
      ].join('\n')
    });
  };
}
