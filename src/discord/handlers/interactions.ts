// Single entry point for every interaction Discord sends us. Dispatches by
// type and (for chat-input commands) by command name.
//
// All handlers are loaded statically — no dynamic discovery — so the
// dispatch table is obvious from the code.
import type { Client, Interaction } from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

import * as tagSession from '../commands/tagSession.js';
import * as recap from '../commands/recap.js';
import * as whodunit from '../commands/whodunit.js';
import { handleNeedsReviewButton, isNeedsReviewButton } from './needsReviewButtons.js';

interface CommandModule {
  execute: (interaction: import('discord.js').ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: import('discord.js').AutocompleteInteraction) => Promise<void>;
}

const COMMANDS: Record<string, CommandModule> = {
  'tag-session': tagSession,
  recap,
  whodunit
};

export function wireInteractionHandler(client: Client, log: FastifyBaseLogger): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const mod = COMMANDS[interaction.commandName];
        if (!mod) {
          log.warn({ commandName: interaction.commandName }, 'unknown slash command');
          return;
        }
        await mod.execute(interaction);
        return;
      }
      if (interaction.isAutocomplete()) {
        const mod = COMMANDS[interaction.commandName];
        if (!mod?.autocomplete) return;
        await mod.autocomplete(interaction);
        return;
      }
      if (interaction.isButton()) {
        if (isNeedsReviewButton(interaction.customId)) {
          await handleNeedsReviewButton(interaction);
        }
        return;
      }
    } catch (err) {
      log.error({ err, interactionId: interaction.id }, 'interaction handler crashed');
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'Something broke while handling this interaction. Check the logs.',
            ephemeral: true
          });
        }
      } catch {
        // best-effort; ignore
      }
    }
  });
}
