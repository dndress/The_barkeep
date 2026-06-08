// /ask — the Barkeep answers in-character.
//
// Channel must map to a campaign. Asker's character is resolved via their
// most recent SessionPlayer in that campaign. Reply is public (everyone
// in the channel sees it). Gemini call can take several seconds — we
// defer the reply so Discord doesn't time out at 3s.
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

import { ask } from '../../rag/ask.js';

export const data = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('Ask the Barkeep about past sessions of this campaign')
  .addStringOption((o) =>
    o.setName('question').setDescription('What would you ask the Barkeep?').setRequired(true)
  );

export interface AskCommandDeps {
  log: FastifyBaseLogger;
  embedModel: string;
  askModel: string;
  topK: number;
  embedTimeoutMs: number;
  askTimeoutMs: number;
}

export function makeExecute(deps: AskCommandDeps) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (!interaction.channelId) {
      await interaction.reply({
        content: 'Run /ask from inside a campaign channel.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const question = interaction.options.getString('question', true).trim();
    if (!question) {
      await interaction.reply({
        content: 'You need to ask something, traveler.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // Public reply — defer first so we have time to embed + retrieve + generate.
    await interaction.deferReply();

    const result = await ask({
      discordUserId: interaction.user.id,
      discordChannelId: interaction.channelId,
      question,
      embedModel: deps.embedModel,
      askModel: deps.askModel,
      topK: deps.topK,
      embedTimeoutMs: deps.embedTimeoutMs,
      askTimeoutMs: deps.askTimeoutMs
    });

    if (!result.ok) {
      deps.log.warn(
        { reason: result.reason, discordUserId: interaction.user.id, question },
        'ask failed user-facing'
      );
      await interaction.editReply({ content: result.userFacing });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xb87333)
      .setAuthor({ name: `🍺 The Barkeep — ${result.campaignName}` })
      .setDescription(result.reply.slice(0, 4000))
      .addFields({
        name: '​',
        value: `_❝ ${question.slice(0, 200)} ❞_`
      })
      .setFooter({
        text: `Recalling tales from ${result.embeddedSessions} session${result.embeddedSessions === 1 ? '' : 's'} • ${result.retrievedCount} fragments`
      });

    await interaction.editReply({ embeds: [embed] });
  };
}
