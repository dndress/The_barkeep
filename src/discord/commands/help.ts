// /help — lists every slash command this bot exposes, with descriptions.
//
// Pulled dynamically from each command's SlashCommandBuilder so the help
// output stays in sync with what's actually registered. Add a new command
// to ALL_COMMANDS and it shows up here automatically.
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { data as tagSessionData } from './tagSession.js';
import { data as recapData } from './recap.js';
import { data as whodunitData } from './whodunit.js';
import { data as transcriptionSourceData } from './transcriptionSource.js';
import { data as driveFolderData } from './driveFolder.js';
import { data as checkDriveData } from './checkDrive.js';
import { data as useGeminiForData } from './useGeminiFor.js';
import { data as askData } from './ask.js';
import { data as briefData } from './brief.js';
import { data as regenArtData } from './regenArt.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('List every Barkeep slash command and what it does');

const ALL_COMMANDS = [
  askData,
  briefData,
  checkDriveData,
  driveFolderData,
  recapData,
  regenArtData,
  tagSessionData,
  transcriptionSourceData,
  useGeminiForData,
  whodunitData
];

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const lines = ALL_COMMANDS
    .map((c) => `**/${c.name}** — ${c.description}`)
    .sort((a, b) => a.localeCompare(b));
  lines.push('**/help** — List every Barkeep slash command and what it does');

  const embed = new EmbedBuilder()
    .setTitle('Barkeep — available commands')
    .setDescription(lines.join('\n'))
    .setColor(0x8b5a2b);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
