// /brief — admin command. Sends Rikk's pre-session DM to each player
// individually for their character. Run it from the campaign channel
// whenever you want the party reminded of where they left off.
//
// Permission: admin-only (ADMIN_DISCORD_USER_ID), matches /tag-session.
//
// Per-character DM contents come from src/rag/brief.ts. This file is
// just orchestration: resolve campaign, fan out, deliver.
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../../db.js';
import { getDiscordClient } from '../client.js';
import { buildCharacterBrief } from '../../rag/brief.js';

export const data = new SlashCommandBuilder()
  .setName('brief')
  .setDescription('Send each player a private pre-session brief in Rikk\'s voice (admin only)');

export interface BriefCommandDeps {
  log: FastifyBaseLogger;
  briefModel: string;
  briefLanguageHint: string;
  briefTimeoutMs: number;
  recentSessionsToInclude: number;
  memoriesToInclude: number;
}

export function makeExecute(deps: BriefCommandDeps) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    // 1. Admin gate.
    const adminId = process.env.ADMIN_DISCORD_USER_ID;
    if (!adminId || interaction.user.id !== adminId) {
      await interaction.reply({
        content: 'This command is admin-only.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // 2. Channel → campaign.
    if (!interaction.channelId) {
      await interaction.reply({
        content: 'Run /brief from inside a campaign channel.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const prisma = getPrisma();
    const campaign = await prisma.campaign.findUnique({
      where: { discordTextChannelId: interaction.channelId },
      select: { id: true, name: true }
    });
    if (!campaign) {
      await interaction.reply({
        content: 'This channel is not tied to a campaign.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // 3. Roster: active characters in the campaign + their owner Discord IDs.
    const characters = await prisma.character.findMany({
      where: { campaignId: campaign.id, active: true },
      select: {
        id: true,
        name: true,
        user: { select: { discordUserId: true, displayName: true, isBot: true } }
      },
      orderBy: { name: 'asc' }
    });
    if (characters.length === 0) {
      await interaction.reply({
        content: `No active characters on file for **${campaign.name}**.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // 4. Defer — generation + DM fanout can take a while.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const client = getDiscordClient();
    const sent: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];

    for (const ch of characters) {
      if (ch.user.isBot) {
        skipped.push(`${ch.name} (owner is a bot user)`);
        continue;
      }
      try {
        const brief = await buildCharacterBrief({
          prisma,
          campaignId: campaign.id,
          characterId: ch.id,
          model: deps.briefModel,
          languageHint: deps.briefLanguageHint,
          timeoutMs: deps.briefTimeoutMs,
          recentSessionsToInclude: deps.recentSessionsToInclude,
          memoriesToInclude: deps.memoriesToInclude
        });

        const player = await client.users.fetch(ch.user.discordUserId);
        // Discord DM cap is 2000 chars. The brief target is ~250 words
        // (~1500 chars) so we shouldn't hit it, but slice defensively.
        const header = `📜 **Rikk — pre-session brief for ${ch.name}** · *${campaign.name}*\n\n`;
        const body = brief.text;
        const message = (header + body).slice(0, 2000);
        await player.send({ content: message });
        sent.push(ch.name);
        deps.log.info(
          {
            campaign: campaign.name,
            character: ch.name,
            recipientDiscordId: ch.user.discordUserId,
            sparse: brief.sparse
          },
          'brief DM delivered'
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          {
            err: msg,
            campaign: campaign.name,
            character: ch.name,
            recipientDiscordId: ch.user.discordUserId
          },
          'brief DM failed'
        );
        failed.push(`${ch.name} (${msg.slice(0, 80)})`);
      }
    }

    // 5. Admin-facing summary.
    const lines: string[] = [`**Brief delivery for ${campaign.name}**`];
    if (sent.length) lines.push(`✅ Sent: ${sent.join(', ')}`);
    if (skipped.length) lines.push(`⏭ Skipped: ${skipped.join(', ')}`);
    if (failed.length) lines.push(`❌ Failed: ${failed.join(', ')}`);
    if (sent.length === 0 && failed.length === 0 && skipped.length === 0) {
      lines.push('_(nothing happened — no characters processed)_');
    }
    await interaction.editReply({ content: lines.join('\n').slice(0, 2000) });
  };
}
