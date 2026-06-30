// /name-alias — admin-only. Manage per-campaign name-correction lexicon
// and optionally backfill past sessions.
//
// Subcommands:
//   /name-alias add wrong:<str> right:<str>
//       Adds an alias for the current channel's campaign. All future
//       ingest passes auto-correct `wrong` → `right` everywhere upstream
//       of embedding: per-track transcripts, combined transcript,
//       summarizer output (defensive pass).
//
//   /name-alias remove wrong:<str>
//       Removes an alias for the current channel's campaign.
//
//   /name-alias list
//       Lists all aliases for the current channel's campaign.
//
//   /name-alias apply-to-session session:<UUID>
//       Backfill: re-applies every currently-registered alias for the
//       session's campaign to that session's transcripts + summary +
//       memories + art prompt, then nulls embedded_at so the worker
//       re-embeds chunks from the corrected text on its next sweep.
//       The reply shows per-table replacement counts before commit so
//       the admin can verify the scope of the rewrite.
//
// Inert when no aliases are registered. The ingest helpers all early-
// return on empty alias lists, so this whole subsystem has zero effect
// until the admin uses /name-alias add.
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';
import {
  applyAliases,
  applyAliasesToJson,
  countReplacements,
  loadAliasesForCampaign,
  type NameAlias
} from '../../pipeline/nameAliases.js';

export const data = new SlashCommandBuilder()
  .setName('name-alias')
  .setDescription('Manage per-campaign name corrections for transcription typos (admin only)')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Register a typo → correction for the current channel\'s campaign')
      .addStringOption((o) =>
        o.setName('wrong').setDescription('Typo as it appears in transcripts (e.g. "Salad")').setRequired(true)
      )
      .addStringOption((o) =>
        o.setName('right').setDescription('Correct spelling (e.g. "Salat")').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a registered alias for the current channel\'s campaign')
      .addStringOption((o) =>
        o.setName('wrong').setDescription('The typo to stop correcting').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('List all aliases for the current channel\'s campaign')
  )
  .addSubcommand((sub) =>
    sub
      .setName('apply-to-session')
      .setDescription('Backfill all current campaign aliases to one past session; triggers re-embed')
      .addStringOption((o) =>
        o.setName('session').setDescription('Session UUID').setRequired(true)
      )
  );

async function resolveCampaignFromChannel(
  prisma: ReturnType<typeof getPrisma>,
  channelId: string | null
): Promise<{ id: string; name: string } | null> {
  if (!channelId) return null;
  const c = await prisma.campaign.findUnique({
    where: { discordTextChannelId: channelId },
    select: { id: true, name: true }
  });
  return c;
}

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  const adminId = process.env.ADMIN_DISCORD_USER_ID;
  return Boolean(adminId) && interaction.user.id === adminId;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'This command is admin-only.', flags: MessageFlags.Ephemeral });
    return;
  }

  const sub = interaction.options.getSubcommand(true);
  const prisma = getPrisma();

  if (sub === 'apply-to-session') {
    await applyToSession(interaction, prisma);
    return;
  }

  // add / remove / list all require channel→campaign resolution.
  const campaign = await resolveCampaignFromChannel(prisma, interaction.channelId ?? null);
  if (!campaign) {
    await interaction.reply({
      content: 'This channel isn\'t mapped to a campaign. Run /name-alias from a campaign channel.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (sub === 'add') {
    const wrong = interaction.options.getString('wrong', true).trim();
    const right = interaction.options.getString('right', true).trim();
    if (!wrong || !right) {
      await interaction.reply({ content: 'Both `wrong` and `right` must be non-empty.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (wrong === right) {
      await interaction.reply({ content: '`wrong` and `right` are identical — nothing to do.', flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await prisma.campaignNameAlias.upsert({
        where: { campaignId_wrong: { campaignId: campaign.id, wrong } },
        update: { right, createdBy: interaction.user.id },
        create: { campaignId: campaign.id, wrong, right, createdBy: interaction.user.id }
      });
      await interaction.reply({
        content: `✅ Alias registered for **${campaign.name}**: \`${wrong}\` → \`${right}\`. Applies to all future ingest. Use \`/name-alias apply-to-session\` to backfill an existing session.`,
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      await interaction.reply({
        content: `Failed to register alias: ${(err as Error).message}`.slice(0, 2000),
        flags: MessageFlags.Ephemeral
      });
    }
    return;
  }

  if (sub === 'remove') {
    const wrong = interaction.options.getString('wrong', true).trim();
    const deleted = await prisma.campaignNameAlias.deleteMany({
      where: { campaignId: campaign.id, wrong }
    });
    await interaction.reply({
      content:
        deleted.count > 0
          ? `🗑️ Removed alias \`${wrong}\` for **${campaign.name}**. Future ingest will no longer correct it.`
          : `No alias \`${wrong}\` registered for **${campaign.name}**.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (sub === 'list') {
    const rows = await prisma.campaignNameAlias.findMany({
      where: { campaignId: campaign.id },
      orderBy: { wrong: 'asc' },
      select: { wrong: true, right: true, createdAt: true }
    });
    if (rows.length === 0) {
      await interaction.reply({
        content: `No aliases registered for **${campaign.name}**. Use \`/name-alias add\` to register one.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const lines = rows.map((r) => `• \`${r.wrong}\` → \`${r.right}\``);
    const body = `**${campaign.name}** aliases (${rows.length}):\n${lines.join('\n')}`;
    await interaction.reply({ content: body.slice(0, 2000), flags: MessageFlags.Ephemeral });
    return;
  }
}

async function applyToSession(
  interaction: ChatInputCommandInteraction,
  prisma: ReturnType<typeof getPrisma>
): Promise<void> {
  const sessionId = interaction.options.getString('session', true).trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      campaignId: true,
      sessionNumber: true,
      campaign: { select: { name: true } }
    }
  });
  if (!session) {
    await interaction.editReply(`No session with id \`${sessionId}\`.`);
    return;
  }
  if (!session.campaignId) {
    await interaction.editReply(
      `Session \`${sessionId}\` has no campaign yet — wait until campaign detection finishes, or run \`/tag-session\` first.`
    );
    return;
  }

  const aliases: NameAlias[] = await loadAliasesForCampaign(prisma, session.campaignId);
  if (aliases.length === 0) {
    await interaction.editReply(
      `No aliases registered for **${session.campaign?.name ?? 'this campaign'}**. Add some with \`/name-alias add\` first.`
    );
    return;
  }

  // 1) Per-track transcripts.
  const transcripts = await prisma.transcript.findMany({
    where: { audioFile: { chapter: { sessionId } } },
    select: { id: true, fullText: true, segments: true }
  });
  let transcriptHits = 0;
  for (const t of transcripts) {
    transcriptHits += countReplacements(t.fullText, aliases);
    const segmentsText = typeof t.segments === 'string'
      ? t.segments
      : JSON.stringify(t.segments ?? null);
    transcriptHits += countReplacements(segmentsText, aliases);
  }

  // 2) Combined transcript.
  const combined = await prisma.combinedTranscript.findUnique({
    where: { sessionId },
    select: { id: true, fullText: true, segments: true }
  });
  let combinedHits = 0;
  if (combined) {
    combinedHits += countReplacements(combined.fullText, aliases);
    combinedHits += countReplacements(JSON.stringify(combined.segments ?? null), aliases);
  }

  // 3) Summary.
  const summary = await prisma.summary.findUnique({
    where: { sessionId },
    select: { id: true, short: true, full: true, keyEvents: true }
  });
  let summaryHits = 0;
  if (summary) {
    summaryHits += countReplacements(summary.short, aliases);
    summaryHits += countReplacements(summary.full, aliases);
    summaryHits += countReplacements(JSON.stringify(summary.keyEvents ?? null), aliases);
  }

  // 4) Character memories.
  const memories = await prisma.characterMemory.findMany({
    where: { sessionId },
    select: { id: true, content: true }
  });
  let memoryHits = 0;
  for (const m of memories) memoryHits += countReplacements(m.content, aliases);

  // 5) Art prompts.
  const artPieces = await prisma.artPiece.findMany({
    where: { sessionId },
    select: { id: true, prompt: true }
  });
  let artHits = 0;
  for (const a of artPieces) artHits += countReplacements(a.prompt, aliases);

  const totalHits = transcriptHits + combinedHits + summaryHits + memoryHits + artHits;
  if (totalHits === 0) {
    await interaction.editReply(
      `No occurrences found in session \`${sessionId}\` for any of the ${aliases.length} registered alias${aliases.length === 1 ? '' : 'es'}. Nothing to rewrite.`
    );
    return;
  }

  // Apply + persist inside a transaction so a mid-write failure leaves the
  // DB consistent. Embedding is reset OUTSIDE the txn — worst case it stays
  // un-nulled and the admin retries.
  await prisma.$transaction(async (tx) => {
    for (const t of transcripts) {
      await tx.transcript.update({
        where: { id: t.id },
        data: {
          fullText: applyAliases(t.fullText, aliases),
          segments: applyAliasesToJson(t.segments, aliases) as unknown as object
        }
      });
    }
    if (combined) {
      await tx.combinedTranscript.update({
        where: { id: combined.id },
        data: {
          fullText: applyAliases(combined.fullText, aliases),
          segments: applyAliasesToJson(combined.segments, aliases) as unknown as object
        }
      });
    }
    if (summary) {
      await tx.summary.update({
        where: { id: summary.id },
        data: {
          short: applyAliases(summary.short, aliases),
          full: applyAliases(summary.full, aliases),
          keyEvents: applyAliasesToJson(summary.keyEvents, aliases) as unknown as object
        }
      });
    }
    for (const m of memories) {
      await tx.characterMemory.update({
        where: { id: m.id },
        data: { content: applyAliases(m.content, aliases) }
      });
    }
    for (const a of artPieces) {
      await tx.artPiece.update({
        where: { id: a.id },
        data: { prompt: applyAliases(a.prompt, aliases) }
      });
    }
  });

  // Trigger re-embed on the worker's next sweep.
  await prisma.session.update({
    where: { id: session.id },
    data: { embeddedAt: null, embedAttempts: 0, embedError: null }
  });

  const tag = session.campaign?.name
    ? `${session.campaign.name} S${session.sessionNumber ?? '?'}`
    : sessionId;
  await interaction.editReply(
    [
      `✅ Backfilled **${tag}** with ${aliases.length} alias${aliases.length === 1 ? '' : 'es'} (${totalHits} total replacement${totalHits === 1 ? '' : 's'}).`,
      `• transcripts: ${transcriptHits}`,
      `• combined transcript: ${combinedHits}`,
      `• summary: ${summaryHits}`,
      `• character memories: ${memoryHits}`,
      `• art prompts: ${artHits}`,
      ``,
      `Embedding queued for rebuild — worker will redo chunks on its next sweep.`,
      `If this session is already POSTED, you may want \`/post-recap-now\` after the summary is visible.`
    ].join('\n').slice(0, 2000)
  );
}
