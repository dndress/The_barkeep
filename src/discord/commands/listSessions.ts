// /list-sessions — admin-only sessions listing.
//
// Saves a trip to the VPS + psql. Prints recent sessions with their full
// UUIDs (copy-paste-ready for /tag-session, /recap, /regen-art, etc.),
// campaign, session number, status, and start date.
//
// Options:
//   limit:    1-50 (default 20), most-recent first.
//   status:   optional filter on SessionStatus enum.
//   campaign: optional filter on campaign name (autocomplete from active).
//
// Output: ephemeral embed. Description holds the list (Discord 4096 cap).
// We line-budget so we never overflow; if we'd overflow, we truncate the
// tail and append a "(+N more not shown — narrow your filter)" hint.
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

const STATUS_CHOICES = [
  'RECEIVING',
  'COOKING',
  'TRANSCRIBING',
  'SUMMARIZING',
  'NEEDS_PLAYER_REVIEW',
  'READY',
  'POSTED',
  'NEEDS_REVIEW',
  'FAILED'
] as const;
type StatusName = (typeof STATUS_CHOICES)[number];

const STATUS_EMOJI: Record<StatusName, string> = {
  RECEIVING: '📥',
  COOKING: '🍳',
  TRANSCRIBING: '🎙️',
  SUMMARIZING: '📝',
  NEEDS_PLAYER_REVIEW: '🧍',
  READY: '✅',
  POSTED: '📣',
  NEEDS_REVIEW: '🛠️',
  FAILED: '❌'
};

// Discord embed description cap is 4096; leave a comfortable margin for
// the header line and the "+N more" footer.
const DESCRIPTION_BUDGET = 3900;

export const data = new SlashCommandBuilder()
  .setName('list-sessions')
  .setDescription('List recent sessions with their IDs (admin only)')
  .addIntegerOption((o) =>
    o
      .setName('limit')
      .setDescription('Max sessions to show (1-50, default 20)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(50)
  )
  .addStringOption((o) => {
    o.setName('status').setDescription('Filter by status').setRequired(false);
    for (const s of STATUS_CHOICES) o.addChoices({ name: s, value: s });
    return o;
  })
  .addStringOption((o) =>
    o
      .setName('campaign')
      .setDescription('Filter by campaign name')
      .setRequired(false)
      .setAutocomplete(true)
  );

function formatDate(d: Date | null | undefined): string {
  if (!d) return '—';
  // YYYY-MM-DD in UTC; cheap, unambiguous, locale-free.
  return d.toISOString().slice(0, 10);
}

interface SessionRow {
  id: string;
  status: StatusName;
  startedAt: Date;
  sessionNumber: number | null;
  campaignName: string | null;
}

function formatSessionLine(r: SessionRow): string {
  const emoji = STATUS_EMOJI[r.status] ?? '•';
  const campaign = r.campaignName ?? '_(untagged)_';
  const sn = r.sessionNumber != null ? `S${r.sessionNumber}` : 'S?';
  return `${emoji} \`${r.id}\` — ${campaign} ${sn} · ${formatDate(r.startedAt)}`;
}

/**
 * Pack lines into the description budget. Returns the joined block plus a
 * shown-count so the caller can append "(+N more)" if anything was dropped.
 */
export function packLines(
  lines: string[],
  budget: number
): { block: string; shown: number } {
  let used = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const cost = (kept.length > 0 ? 1 : 0) + line.length; // +1 for the \n
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return { block: kept.join('\n'), shown: kept.length };
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

  const limit = interaction.options.getInteger('limit', false) ?? 20;
  const statusFilter = interaction.options.getString('status', false) as StatusName | null;
  const campaignFilter = interaction.options.getString('campaign', false);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const prisma = getPrisma();

  // Resolve campaign filter (if given) to an id in this guild.
  let campaignIdFilter: string | null = null;
  if (campaignFilter) {
    const c = await prisma.campaign.findFirst({
      where: {
        name: campaignFilter,
        ...(interaction.guildId ? { discordGuildId: interaction.guildId } : {})
      },
      select: { id: true }
    });
    if (!c) {
      await interaction.editReply(`No campaign named "${campaignFilter}" in this guild.`);
      return;
    }
    campaignIdFilter = c.id;
  }

  const sessions = await prisma.session.findMany({
    where: {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(campaignIdFilter ? { campaignId: campaignIdFilter } : {}),
      ...(interaction.guildId ? { discordGuildId: interaction.guildId } : {})
    },
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      status: true,
      startedAt: true,
      sessionNumber: true,
      campaign: { select: { name: true } }
    }
  });

  if (sessions.length === 0) {
    await interaction.editReply('No sessions matched.');
    return;
  }

  const rows: SessionRow[] = sessions.map((s) => ({
    id: s.id,
    status: s.status as StatusName,
    startedAt: s.startedAt,
    sessionNumber: s.sessionNumber,
    campaignName: s.campaign?.name ?? null
  }));
  const lines = rows.map(formatSessionLine);
  const { block, shown } = packLines(lines, DESCRIPTION_BUDGET);
  const overflow = lines.length - shown;
  const description =
    block + (overflow > 0 ? `\n_(+${overflow} more not shown — narrow your filter)_` : '');

  const filters: string[] = [];
  if (statusFilter) filters.push(`status=${statusFilter}`);
  if (campaignFilter) filters.push(`campaign=${campaignFilter}`);
  const title = filters.length
    ? `Sessions (${shown}/${lines.length}) — ${filters.join(', ')}`
    : `Recent sessions (${shown}/${lines.length})`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0xb87333)
    .setFooter({ text: 'IDs are full UUIDs — copy-paste into /tag-session, /recap, etc.' });

  await interaction.editReply({ embeds: [embed] });
}

export async function autocomplete(
  interaction: import('discord.js').AutocompleteInteraction
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'campaign') return;
  const prisma = getPrisma();
  const guildId = interaction.guildId ?? undefined;
  const campaigns = await prisma.campaign.findMany({
    where: { ...(guildId ? { discordGuildId: guildId } : {}) },
    select: { name: true },
    take: 25
  });
  const q = focused.value.toLowerCase();
  const choices = campaigns
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((c) => ({ name: c.name, value: c.name }));
  await interaction.respond(choices);
}
