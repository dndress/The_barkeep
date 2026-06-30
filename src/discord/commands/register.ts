// One-shot slash-command registration at bot startup.
//
// We register guild-scoped (not global) because:
//   - Guild-scoped propagates instantly; global takes up to an hour.
//   - The bot only lives in one guild for now; no need for global reach.
//
// Discord dedupes by command name on registration, so it's idempotent --
// re-running on every boot is fine and ensures any name/description
// changes propagate without manual intervention.
import type { Client } from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

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
import { data as helpData } from './help.js';
import { data as listSessionsData } from './listSessions.js';
import { data as recallData } from './recall.js';
import { data as pipelineStatusData } from './pipelineStatus.js';
import { data as postRecapNowData } from './postRecapNow.js';
import { data as nameAliasData } from './nameAlias.js';

export async function registerSlashCommands(
  client: Client,
  guildId: string,
  log: FastifyBaseLogger
): Promise<void> {
  if (!client.application) {
    throw new Error('client.application is null at registration time -- client must be ready');
  }
  const guild = await client.guilds.fetch(guildId);
  const commands = [
    tagSessionData.toJSON(),
    recapData.toJSON(),
    whodunitData.toJSON(),
    transcriptionSourceData.toJSON(),
    driveFolderData.toJSON(),
    checkDriveData.toJSON(),
    useGeminiForData.toJSON(),
    askData.toJSON(),
    briefData.toJSON(),
    regenArtData.toJSON(),
    helpData.toJSON(),
    listSessionsData.toJSON(),
    recallData.toJSON(),
    pipelineStatusData.toJSON(),
    postRecapNowData.toJSON(),
    nameAliasData.toJSON()
  ];
  await guild.commands.set(commands);
  log.info({ guildId, count: commands.length }, 'slash commands registered');
}
