// One-shot slash-command registration at bot startup.
//
// We register guild-scoped (not global) because:
//   - Guild-scoped propagates instantly; global takes up to an hour.
//   - The bot only lives in one guild for now; no need for global reach.
//
// Discord dedupes by command name on registration, so it's idempotent —
// re-running on every boot is fine and ensures any name/description
// changes propagate without manual intervention.
import type { Client } from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

import { data as tagSessionData } from './tagSession.js';
import { data as recapData } from './recap.js';
import { data as whodunitData } from './whodunit.js';

export async function registerSlashCommands(
  client: Client,
  guildId: string,
  log: FastifyBaseLogger
): Promise<void> {
  if (!client.application) {
    throw new Error('client.application is null at registration time — client must be ready');
  }
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([tagSessionData.toJSON(), recapData.toJSON(), whodunitData.toJSON()]);
  log.info({ guildId, count: 3 }, 'slash commands registered');
}
