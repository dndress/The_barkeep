// Handles button clicks on a "session player needs review" DM.
//
// customId formats (kept short — Discord caps customId at 100 chars):
//   pp:assign:<sessionId>:<userPrefix>:<characterPrefix>
//   pp:skip:<sessionId>:<userPrefix>
//
// We use 8-char prefixes for userId and characterId — within a single
// session collision probability is negligible. The full sessionId is
// included verbatim so we can find the right row directly.
import { ButtonInteraction, MessageFlags } from 'discord.js';

import { getPrisma } from '../../db.js';

const PREFIX = 'pp:';

export function isPlayerReviewButton(customId: string): boolean {
  return customId.startsWith(PREFIX);
}

async function maybeAdvanceSession(sessionId: string): Promise<boolean> {
  const prisma = getPrisma();
  // If no more null-character player rows, advance the session.
  const remaining = await prisma.sessionPlayer.findFirst({
    where: { sessionId, role: 'PLAYER', characterId: null }
  });
  if (remaining) return false;
  await prisma.session.update({
    where: { id: sessionId },
    data: { status: 'SUMMARIZING' }
  });
  return true;
}

export async function handlePlayerReviewButton(interaction: ButtonInteraction): Promise<void> {
  const adminId = process.env.ADMIN_DISCORD_USER_ID;
  if (!adminId || interaction.user.id !== adminId) {
    await interaction.reply({
      content: 'These player-review buttons are admin-only.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const parts = interaction.customId.split(':');
  // ['pp', action, sessionId, userPrefix, charPrefix?]
  if (parts.length < 4) {
    await interaction.reply({
      content: 'Malformed player-review button.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const [, action, sessionId, userPrefix, charPrefix] = parts;
  if (!action || !sessionId || !userPrefix) {
    await interaction.reply({
      content: 'Malformed player-review button.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const prisma = getPrisma();

  // Resolve the session_player row using session + user prefix. Within a
  // session, user_id prefixes are guaranteed unique by Postgres (PK is
  // (session_id, user_id)).
  const sp = await prisma.sessionPlayer.findFirst({
    where: {
      sessionId,
      userId: { startsWith: userPrefix }
    },
    include: { user: { select: { displayName: true } } }
  });
  if (!sp) {
    await interaction.update({
      content: `Couldn't find that player on session \`${sessionId.slice(0, 8)}…\`.`,
      components: []
    });
    return;
  }

  if (action === 'skip') {
    // Leave character_id NULL — summarizer falls back to display_name.
    const advanced = await maybeAdvanceSession(sessionId);
    const trailing = advanced
      ? '\n\n_All players resolved — pipeline resuming._'
      : '';
    const orig = interaction.message.content ?? '';
    await interaction.update({
      content: `${orig}\n\n⏭️ **Skipped** — ${sp.user.displayName} will appear under their real name in the summary.${trailing}`,
      components: []
    });
    return;
  }

  if (action !== 'assign' || !charPrefix) {
    await interaction.update({
      content: 'Unknown action.',
      components: []
    });
    return;
  }

  // Resolve character by prefix; scope to characters in this session's campaign.
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { campaignId: true }
  });
  if (!session?.campaignId) {
    await interaction.update({
      content: 'Session has no campaign — assign the campaign first via the original review DM.',
      components: []
    });
    return;
  }
  const character = await prisma.character.findFirst({
    where: { campaignId: session.campaignId, id: { startsWith: charPrefix } },
    select: { id: true, name: true }
  });
  if (!character) {
    await interaction.update({
      content: `That character no longer exists in the campaign.`,
      components: []
    });
    return;
  }

  await prisma.sessionPlayer.update({
    where: { sessionId_userId: { sessionId, userId: sp.userId } },
    data: { characterId: character.id, detectedFromVoice: false }
  });

  const advanced = await maybeAdvanceSession(sessionId);
  const trailing = advanced
    ? '\n\n_All players resolved — pipeline resuming._'
    : '';
  const orig = interaction.message.content ?? '';
  await interaction.update({
    content: `${orig}\n\n✅ **${sp.user.displayName} → ${character.name}**${trailing}`,
    components: []
  });
}
