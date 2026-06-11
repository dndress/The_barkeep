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
import * as transcriptionSource from '../commands/transcriptionSource.js';
import * as driveFolder from '../commands/driveFolder.js';
import { makeExecute as makeCheckDriveExecute, data as checkDriveData } from '../commands/checkDrive.js';
import * as useGeminiFor from '../commands/useGeminiFor.js';
import { makeExecute as makeAskExecute, data as askData } from '../commands/ask.js';
import { makeExecute as makeBriefExecute, data as briefData } from '../commands/brief.js';
import { makeExecute as makeRegenArtExecute, data as regenArtData } from '../commands/regenArt.js';
import * as help from '../commands/help.js';
import * as listSessions from '../commands/listSessions.js';
import { handleNeedsReviewButton, isNeedsReviewButton } from './needsReviewButtons.js';
import { handlePlayerReviewButton, isPlayerReviewButton } from './playerReviewButtons.js';

interface CommandModule {
  execute: (interaction: import('discord.js').ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: import('discord.js').AutocompleteInteraction) => Promise<void>;
}

export interface InteractionHandlerDeps {
  googleApiKey: string | undefined;
  // Stage 7
  embedModel: string;
  askModel: string;
  askTopK: number;
  embedTimeoutMs: number;
  askTimeoutMs: number;
  // Stage 9 — /brief
  briefModel: string;
  briefLanguageHint: string;
  briefTimeoutMs: number;
  briefRecentSessions: number;
  briefMemoriesPerCharacter: number;
  // Stage 9 — /regen-art
  sessionArtModel: string;
  sessionArtDir: string;
  sessionArtTimeoutMs: number;
}

export function wireInteractionHandler(
  client: Client,
  log: FastifyBaseLogger,
  deps: InteractionHandlerDeps
): void {
  const COMMANDS: Record<string, CommandModule> = {
    'tag-session': tagSession,
    recap,
    whodunit,
    'transcription-source': transcriptionSource,
    'drive-folder': driveFolder,
    [checkDriveData.name]: { execute: makeCheckDriveExecute({ log, googleApiKey: deps.googleApiKey }) },
    'use-gemini-for': useGeminiFor,
    [askData.name]: {
      execute: makeAskExecute({
        log,
        embedModel: deps.embedModel,
        askModel: deps.askModel,
        topK: deps.askTopK,
        embedTimeoutMs: deps.embedTimeoutMs,
        askTimeoutMs: deps.askTimeoutMs
      })
    },
    [briefData.name]: {
      execute: makeBriefExecute({
        log,
        briefModel: deps.briefModel,
        briefLanguageHint: deps.briefLanguageHint,
        briefTimeoutMs: deps.briefTimeoutMs,
        recentSessionsToInclude: deps.briefRecentSessions,
        memoriesToInclude: deps.briefMemoriesPerCharacter
      })
    },
    [regenArtData.name]: {
      execute: makeRegenArtExecute({
        log,
        sessionArtModel: deps.sessionArtModel,
        sessionArtDir: deps.sessionArtDir,
        sessionArtTimeoutMs: deps.sessionArtTimeoutMs
      })
    },
    help,
    'list-sessions': listSessions
  };
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const mod = COMMANDS[interaction.commandName] as CommandModule | undefined;
        if (!mod) {
          log.warn({ commandName: interaction.commandName }, 'unknown slash command');
          return;
        }
        await mod.execute(interaction);
        return;
      }
      if (interaction.isAutocomplete()) {
        const mod = COMMANDS[interaction.commandName] as CommandModule | undefined;
        if (!mod?.autocomplete) return;
        await mod.autocomplete(interaction);
        return;
      }
      if (interaction.isButton()) {
        if (isNeedsReviewButton(interaction.customId)) {
          await handleNeedsReviewButton(interaction);
        } else if (isPlayerReviewButton(interaction.customId)) {
          await handlePlayerReviewButton(interaction);
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
