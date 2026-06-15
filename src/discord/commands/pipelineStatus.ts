// /pipeline-status — admin-only view of every session still moving through
// the pipeline (i.e. status NOT IN POSTED / FAILED).
//
// Goal: a single ephemeral embed that tells you, at a glance, which
// recordings are pending, what stage they're stuck in, how long they've
// been there, and the most recent failure reason if any.
//
// Grouping: sessions are bucketed by SessionStatus in pipeline order
// (RECEIVING → COOKING → TRANSCRIBING → SUMMARIZING → NEEDS_PLAYER_REVIEW
// → READY → NEEDS_REVIEW). FAILED + POSTED are EXCLUDED by design — this
// command is about *what still needs my attention*. Use /list-sessions
// status:FAILED to see permanently dead sessions.
//
// For each session line, the detail tail varies by stage:
//   SUMMARIZING / NEEDS_REVIEW : attempts + last error (sliced)
//   READY                      : recap_scheduled_for relative time
//   any                        : updated_at relative time (== time-in-stage)
//
// Output budget: Discord embed description cap is 4096. We pack greedily
// across status buckets in pipeline order and append a "+N more" hint
// per overflowing bucket.
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { getPrisma } from '../../db.js';

const IN_FLIGHT_STATUSES = [
  'RECEIVING',
  'COOKING',
  'TRANSCRIBING',
  'SUMMARIZING',
  'NEEDS_PLAYER_REVIEW',
  'READY',
  'NEEDS_REVIEW'
] as const;
type InFlightStatus = (typeof IN_FLIGHT_STATUSES)[number];

const STATUS_EMOJI: Record<InFlightStatus, string> = {
  RECEIVING: '📥',
  COOKING: '🍳',
  TRANSCRIBING: '🎙️',
  SUMMARIZING: '📝',
  NEEDS_PLAYER_REVIEW: '🧍',
  READY: '✅',
  NEEDS_REVIEW: '🛠️'
};

// Pipeline order for bucket display.
const STATUS_ORDER: InFlightStatus[] = [...IN_FLIGHT_STATUSES];

const DESCRIPTION_BUDGET = 3900;
const ERROR_TAIL_MAX = 80;

export const data = new SlashCommandBuilder()
  .setName('pipeline-status')
  .setDescription('Show every in-flight session — anything not yet POSTED (admin only)');

interface PipelineRow {
  id: string;
  status: InFlightStatus;
  campaignName: string | null;
  sessionNumber: number | null;
  startedAt: Date;
  updatedAt: Date;
  recapScheduledFor: Date | null;
  summarizeAttempts: number;
  summarizeError: string | null;
  recapPostAttempts: number;
  recapPostError: string | null;
  driveSetupAttempts: number;
  driveSetupError: string | null;
}

/**
 * Render a relative duration like "3h ago", "12m ago", "2d ago". Floors
 * at "just now" for <60s. Future timestamps get a leading "in ".
 */
export function relTime(d: Date, now: Date = new Date()): string {
  const deltaMs = d.getTime() - now.getTime();
  const future = deltaMs > 0;
  const abs = Math.abs(deltaMs);
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return future ? 'in <1m' : 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return future ? `in ${hr}h` : `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

function shortId(id: string): string {
  // First 8 chars of UUID is enough to copy-paste-disambiguate; full UUID
  // is wrapped in backticks for the cases the admin needs to copy.
  return id.slice(0, 8);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Per-line tail that varies by stage. Surfaces the specific
 * attempt-counter + error field most relevant to that status, so the
 * admin sees the blocker without opening psql.
 */
export function detailForStatus(r: PipelineRow, now: Date = new Date()): string {
  switch (r.status) {
    case 'SUMMARIZING':
    case 'NEEDS_REVIEW': {
      const parts: string[] = [];
      if (r.summarizeAttempts > 0) parts.push(`tries:${r.summarizeAttempts}`);
      if (r.summarizeError) parts.push(`err:"${truncate(r.summarizeError, ERROR_TAIL_MAX)}"`);
      if (parts.length === 0) parts.push(`updated ${relTime(r.updatedAt, now)}`);
      return parts.join(' · ');
    }
    case 'READY': {
      const parts: string[] = [];
      if (r.recapScheduledFor) parts.push(`recap ${relTime(r.recapScheduledFor, now)}`);
      if (r.recapPostAttempts > 0) parts.push(`tries:${r.recapPostAttempts}`);
      if (r.recapPostError) parts.push(`err:"${truncate(r.recapPostError, ERROR_TAIL_MAX)}"`);
      if (parts.length === 0) parts.push(`ready ${relTime(r.updatedAt, now)}`);
      return parts.join(' · ');
    }
    case 'RECEIVING':
    case 'COOKING':
    case 'TRANSCRIBING':
    case 'NEEDS_PLAYER_REVIEW':
    default: {
      const parts: string[] = [];
      parts.push(`updated ${relTime(r.updatedAt, now)}`);
      if (r.driveSetupAttempts > 0) parts.push(`drive-tries:${r.driveSetupAttempts}`);
      if (r.driveSetupError) {
        parts.push(`drive-err:"${truncate(r.driveSetupError, ERROR_TAIL_MAX)}"`);
      }
      return parts.join(' · ');
    }
  }
}

function formatRow(r: PipelineRow, now: Date): string {
  const camp = r.campaignName ?? '_(untagged)_';
  const sn = r.sessionNumber != null ? `S${r.sessionNumber}` : 'S?';
  return `\`${shortId(r.id)}\` ${camp} ${sn} — ${detailForStatus(r, now)}`;
}

/**
 * Pack rows grouped by status into the embed description, respecting
 * the budget. Returns block string + per-status overflow counts so the
 * caller can hint "+N more" inline.
 */
export function packBuckets(
  buckets: Map<InFlightStatus, PipelineRow[]>,
  budget: number,
  now: Date
): string {
  let used = 0;
  const out: string[] = [];
  for (const status of STATUS_ORDER) {
    const rows = buckets.get(status) ?? [];
    if (rows.length === 0) continue;
    const header = `\n${STATUS_EMOJI[status]} **${status}** (${rows.length})`;
    const headerCost = header.length + 1;
    if (used + headerCost > budget) {
      out.push(`\n_(budget exhausted before ${status}; ${rows.length} hidden)_`);
      break;
    }
    out.push(header);
    used += headerCost;
    let shownInBucket = 0;
    for (const r of rows) {
      const line = `\n${formatRow(r, now)}`;
      if (used + line.length > budget) break;
      out.push(line);
      used += line.length;
      shownInBucket += 1;
    }
    const overflow = rows.length - shownInBucket;
    if (overflow > 0) {
      const tail = `\n_(+${overflow} more in ${status})_`;
      if (used + tail.length <= budget) {
        out.push(tail);
        used += tail.length;
      }
    }
  }
  return out.join('').trimStart();
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
  const sessions = await prisma.session.findMany({
    where: {
      status: { in: IN_FLIGHT_STATUSES as unknown as InFlightStatus[] },
      ...(interaction.guildId ? { discordGuildId: interaction.guildId } : {})
    },
    orderBy: [{ updatedAt: 'asc' }], // oldest-in-stage first within each bucket
    select: {
      id: true,
      status: true,
      startedAt: true,
      updatedAt: true,
      sessionNumber: true,
      recapScheduledFor: true,
      summarizeAttempts: true,
      summarizeError: true,
      recapPostAttempts: true,
      recapPostError: true,
      driveSetupAttempts: true,
      driveSetupError: true,
      campaign: { select: { name: true } }
    }
  });

  if (sessions.length === 0) {
    await interaction.editReply('No in-flight sessions — pipeline is clean. 🍻');
    return;
  }

  const rows: PipelineRow[] = sessions.map((s) => ({
    id: s.id,
    status: s.status as InFlightStatus,
    campaignName: s.campaign?.name ?? null,
    sessionNumber: s.sessionNumber,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    recapScheduledFor: s.recapScheduledFor,
    summarizeAttempts: s.summarizeAttempts,
    summarizeError: s.summarizeError,
    recapPostAttempts: s.recapPostAttempts,
    recapPostError: s.recapPostError,
    driveSetupAttempts: s.driveSetupAttempts,
    driveSetupError: s.driveSetupError
  }));

  const buckets = new Map<InFlightStatus, PipelineRow[]>();
  for (const r of rows) {
    const arr = buckets.get(r.status) ?? [];
    arr.push(r);
    buckets.set(r.status, arr);
  }

  const now = new Date();
  const description = packBuckets(buckets, DESCRIPTION_BUDGET, now);
  const total = rows.length;

  const embed = new EmbedBuilder()
    .setTitle(`In-flight sessions (${total})`)
    .setDescription(description)
    .setColor(0xb87333)
    .setFooter({
      text: 'Short IDs shown — use /list-sessions for full UUIDs. POSTED + FAILED excluded.'
    });

  await interaction.editReply({ embeds: [embed] });
}
