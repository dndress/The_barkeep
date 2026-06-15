// /post-recap-now — admin-only. Bypass the 10-hour `recap_scheduled_for`
// delay and force the worker's recap-poster step to fire on its next tick
// (≤30s). NOT a direct Discord send — we just reset the bookkeeping fields
// the worker already keys off in `postOneScheduledRecap`. This keeps the
// embed-build / art-attach / status-transition logic in ONE place
// (recapPoster.ts) instead of duplicating it here.
//
// Target resolution (in order):
//   1. session:<UUID>           — explicit session by primary key
//   2. session_number:N in a campaign channel — explicit session by number
//   3. no args, in campaign channel — latest summarized session (READY or
//      POSTED) for that campaign
//
// Behavior by current status:
//   READY        → reset recap_scheduled_for=now(), clear post bookkeeping
//   POSTED       → flip back to READY, same reset. Caller is responsible
//                  for deleting the prior channel message — we don't, and
//                  the embed will appear as a second post otherwise.
//   anything else→ refuse (summary not ready, can't post)
//
// We do NOT touch ArtPiece rows. If art was generated previously it gets
// re-attached automatically; if it was never generated the recap posts
// without an image (same as the normal path).
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('post-recap-now')
  .setDescription('Force the worker to post a session recap immediately (admin only)')
  .addStringOption((o) =>
    o
      .setName('session')
      .setDescription('Session UUID (overrides session_number + channel default)')
      .setRequired(false)
  )
  .addIntegerOption((o) =>
    o
      .setName('session_number')
      .setDescription('Session # within the channel\'s campaign (defaults to latest)')
      .setRequired(false)
      .setMinValue(1)
  );

interface ResolvedSession {
  id: string;
  status: string;
  sessionNumber: number | null;
  recapPostedAt: Date | null;
  campaign: { name: string } | null;
  summary: { id: string } | null;
}

async function resolveSession(
  prisma: ReturnType<typeof getPrisma>,
  opts: {
    sessionId: string | null;
    sessionNumber: number | null;
    channelId: string | null;
    guildId: string | null;
  }
): Promise<{ session: ResolvedSession | null; err: string | null }> {
  const baseSelect = {
    id: true,
    status: true,
    sessionNumber: true,
    recapPostedAt: true,
    campaign: { select: { name: true } },
    summary: { select: { id: true } }
  } as const;

  if (opts.sessionId) {
    const s = await prisma.session.findUnique({
      where: { id: opts.sessionId },
      select: baseSelect
    });
    if (!s) return { session: null, err: `No session with id \`${opts.sessionId}\`.` };
    return { session: s as ResolvedSession, err: null };
  }

  if (!opts.channelId) {
    return {
      session: null,
      err: 'Run this from a campaign channel, or pass `session:<UUID>` explicitly.'
    };
  }

  const campaign = await prisma.campaign.findUnique({
    where: { discordTextChannelId: opts.channelId },
    select: { id: true, name: true }
  });
  if (!campaign) {
    return {
      session: null,
      err: 'This channel isn\'t mapped to a campaign. Pass `session:<UUID>` explicitly.'
    };
  }

  if (opts.sessionNumber != null) {
    const s = await prisma.session.findFirst({
      where: { campaignId: campaign.id, sessionNumber: opts.sessionNumber },
      select: baseSelect
    });
    if (!s) {
      return {
        session: null,
        err: `No session #${opts.sessionNumber} in ${campaign.name}.`
      };
    }
    return { session: s as ResolvedSession, err: null };
  }

  // Default: latest summarized session in this campaign — READY or POSTED.
  const s = await prisma.session.findFirst({
    where: {
      campaignId: campaign.id,
      status: { in: ['READY', 'POSTED'] },
      summary: { isNot: null }
    },
    orderBy: { sessionNumber: 'desc' },
    select: baseSelect
  });
  if (!s) {
    return {
      session: null,
      err: `No summarized sessions found for ${campaign.name}.`
    };
  }
  return { session: s as ResolvedSession, err: null };
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

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const prisma = getPrisma();
  const sessionIdInput = interaction.options.getString('session', false);
  const sessionNumberInput = interaction.options.getInteger('session_number', false);

  const { session, err } = await resolveSession(prisma, {
    sessionId: sessionIdInput,
    sessionNumber: sessionNumberInput,
    channelId: interaction.channelId ?? null,
    guildId: interaction.guildId ?? null
  });
  if (err || !session) {
    await interaction.editReply(err ?? 'Could not resolve target session.');
    return;
  }

  if (!session.summary) {
    await interaction.editReply(
      `Session \`${session.id}\` has no summary yet — can't post a recap. Current status: \`${session.status}\`.`
    );
    return;
  }

  if (session.status !== 'READY' && session.status !== 'POSTED') {
    await interaction.editReply(
      `Session \`${session.id}\` is in status \`${session.status}\`, not READY/POSTED. ` +
        `The summary pipeline hasn't finished — wait for it, or fix whatever is blocking the upstream stage first.`
    );
    return;
  }

  const wasAlreadyPosted = session.status === 'POSTED' || session.recapPostedAt != null;

  await prisma.session.update({
    where: { id: session.id },
    data: {
      status: 'READY',
      recapScheduledFor: new Date(),
      recapPostedAt: null,
      recapPostAttempts: 0,
      recapPostError: null
    }
  });

  const campaignTag = session.campaign?.name
    ? `${session.campaign.name} S${session.sessionNumber ?? '?'}`
    : `session ${session.id}`;
  const repostNote = wasAlreadyPosted
    ? '\n⚠️ This session was already posted. The worker will post a SECOND copy in the channel — manually delete the prior message if you want a clean replace.'
    : '';
  await interaction.editReply(
    `Queued **${campaignTag}** for immediate recap post. ` +
      `Worker tick is ~30s; watch the channel.${repostNote}`
  );
}
