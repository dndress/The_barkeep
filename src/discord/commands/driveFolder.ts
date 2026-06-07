// /drive-folder — set or show the Drive parent folder where session
// subfolders live. Accepts a folder URL or a raw folder ID.
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('drive-folder')
  .setDescription('Set the Google Drive parent folder for whisper transcripts')
  .addStringOption((o) =>
    o
      .setName('value')
      .setDescription('Folder URL or ID. Use "show" to display the current setting.')
      .setRequired(true)
  );

const FOLDER_ID_REGEX = /[-\w]{25,}/;

function extractFolderId(input: string): string | null {
  // URL forms:
  //   https://drive.google.com/drive/folders/<id>?...
  //   https://drive.google.com/drive/u/0/folders/<id>
  //   <id> directly
  const m = input.match(FOLDER_ID_REGEX);
  return m ? m[0] : null;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const adminId = process.env.ADMIN_DISCORD_USER_ID;
  if (!adminId || interaction.user.id !== adminId) {
    await interaction.reply({
      content: 'This command is admin-only.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const value = interaction.options.getString('value', true).trim();
  const prisma = getPrisma();

  if (value.toLowerCase() === 'show') {
    const settings = await prisma.botSettings.findUnique({ where: { id: 1 } });
    await interaction.reply({
      content: settings?.driveFolderId
        ? `Current Drive folder ID: \`${settings.driveFolderId}\``
        : 'No Drive folder set. Run `/drive-folder value:<url or id>` to set one.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const folderId = extractFolderId(value);
  if (!folderId) {
    await interaction.reply({
      content:
        'Could not extract a folder ID from that. Paste the URL of the folder (looks like https://drive.google.com/drive/folders/abc123…) or the raw ID itself.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  await prisma.botSettings.upsert({
    where: { id: 1 },
    update: { driveFolderId: folderId },
    create: { id: 1, driveFolderId: folderId }
  });
  await interaction.reply({
    content: `✅ Drive folder set to \`${folderId}\`. Bot will poll every 6h; use \`/check-drive\` to poll right now.`,
    flags: MessageFlags.Ephemeral
  });
}
