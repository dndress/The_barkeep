// /regen-art — admin command. Forces session art (re)generation for an
// existing session, deletes any prior ArtPiece, attaches the new image
// inline so the admin can eyeball it without re-posting the recap.
//
// Use cases:
//   - Test that Imagen + appearance descriptions + key_event prompt all
//     compose into something good before relying on it for real recaps.
//   - Re-roll an image you don't like.
//   - Verify the SESSION_ART_DIR volume is mounted correctly.
//
// Permission model matches /tag-session and /brief: admin user only,
// gated on ADMIN_DISCORD_USER_ID.
import { promises as fs } from 'node:fs';

import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../../db.js';
import { generateSessionArt } from '../../pipeline/sessionArt.js';

export const data = new SlashCommandBuilder()
  .setName('regen-art')
  .setDescription('Regenerate session art for a given session (admin only)')
  .addStringOption((o) =>
    o
      .setName('session')
      .setDescription('Session ID (UUID — find via /recap or psql)')
      .setRequired(true)
  );

export interface RegenArtCommandDeps {
  log: FastifyBaseLogger;
  sessionArtModel: string;
  sessionArtDir: string;
  sessionArtTimeoutMs: number;
}

export function makeExecute(deps: RegenArtCommandDeps) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const adminId = process.env.ADMIN_DISCORD_USER_ID;
    if (!adminId || interaction.user.id !== adminId) {
      await interaction.reply({
        content: 'This command is admin-only.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const sessionId = interaction.options.getString('session', true).trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const prisma = getPrisma();

    // Sanity-check the session + summary exist before burning Imagen credits.
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        sessionNumber: true,
        campaign: { select: { name: true } },
        summary: { select: { id: true } }
      }
    });
    if (!session) {
      await interaction.editReply({ content: `No session with id \`${sessionId}\`.` });
      return;
    }
    if (!session.summary) {
      await interaction.editReply({
        content: `Session \`${sessionId}\` has no summary yet — nothing to base art on.`
      });
      return;
    }

    // Force regeneration by removing any existing ArtPiece for this session.
    // generateSessionArt is normally idempotent (skips when one exists), so
    // this is the toggle that lets us re-roll.
    const deleted = await prisma.artPiece.deleteMany({ where: { sessionId } });

    try {
      const result = await generateSessionArt({
        prisma,
        sessionId,
        model: deps.sessionArtModel,
        outputDir: deps.sessionArtDir,
        timeoutMs: deps.sessionArtTimeoutMs,
        log: deps.log
      });

      // Load + attach the freshly generated PNG.
      const buf = await fs.readFile(result.filePath);
      const filename = `session_${session.sessionNumber ?? sessionId.slice(0, 8)}.png`;
      const attachment = new AttachmentBuilder(buf, { name: filename });

      // Truncate the prompt to fit Discord's 2000-char message cap.
      const promptPreview =
        result.prompt.length > 1500 ? result.prompt.slice(0, 1500) + '…' : result.prompt;

      const header = `Regenerated art for **${session.campaign?.name ?? 'unknown campaign'}** — Session ${session.sessionNumber ?? '?'}`;
      const meta = deleted.count > 0 ? ` _(replaced ${deleted.count} prior piece)_` : '';
      const body = `\n\n**Prompt used:**\n\`\`\`\n${promptPreview}\n\`\`\``;

      await interaction.editReply({
        content: (header + meta + body).slice(0, 2000),
        files: [attachment]
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log.warn({ err: msg, sessionId }, '/regen-art failed');
      await interaction.editReply({ content: `Generation failed: ${msg}`.slice(0, 2000) });
    }
  };
}
