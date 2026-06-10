// Reconciliation: turn raw intro-extraction results into DB writes.
//
// Input:  per-track {audioFileId, userId, isDm, characterName, campaignName, confidence}
// Output: either {success: true, ...resolved IDs...} or {success: false, reason}
//
// Why this is its own module: the matching logic (campaign fuzzy match, DM
// disambiguation, character resolution with fallbacks) is non-trivial and
// worth testing independently of the worker plumbing.
import type { PrismaClient } from '@prisma/client';

export interface PerTrackExtraction {
  audioFileId: string;
  userId: string | null;
  trackIndex: number;
  isDm: boolean;
  characterName: string | null;
  campaignName: string | null;
  confidence: number;
}

export interface ReconciliationSuccess {
  success: true;
  campaignId: string;
  dmUserId: string;
  sessionPlayers: Array<{
    userId: string;
    characterId: string | null;
    role: 'DM' | 'PLAYER';
    trackIndex: number;
    detectedFromVoice: boolean;
  }>;
}

export interface ReconciliationFailure {
  success: false;
  reason: string;
  diagnostics: Record<string, unknown>;
}

export type ReconciliationResult = ReconciliationSuccess | ReconciliationFailure;

/**
 * Normalize a campaign or character name for fuzzy comparison. Lowercase,
 * strip diacritics, collapse whitespace, drop common articles. Good enough
 * for the small fixed set of campaigns we have.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/^(the|el|la|los|las)\s+/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Levenshtein-style "close enough" check via shared-token overlap. */
function fuzzyMatches(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Token overlap: at least 2 shared tokens OR all-of-shorter contained in longer
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared >= 2 || (ta.size > 0 && shared === ta.size) || (tb.size > 0 && shared === tb.size);
}

export interface ReconcileOptions {
  prisma: PrismaClient;
  sessionId: string;
  /** Discord guild ID to scope campaigns. */
  discordGuildId: string;
  extractions: PerTrackExtraction[];
  /**
   * Pre-resolved campaign (e.g. admin used /tag-session or a needs-review
   * button). When set, campaign detection from intros is skipped entirely.
   */
  knownCampaignId?: string | null;
  /** Pre-resolved DM user id (admin-supplied). Skips DM detection when set. */
  knownDmUserId?: string | null;
}

export async function reconcileSession(opts: ReconcileOptions): Promise<ReconciliationResult> {
  const { prisma, sessionId, discordGuildId, extractions, knownCampaignId, knownDmUserId } = opts;

  // 1. Campaign resolution. Collect all proposed campaign names from
  // tracks where isDm=true (most reliable), then fall back to all tracks.
  const proposedDmCampaigns = extractions
    .filter((e) => e.isDm && e.campaignName)
    .map((e) => e.campaignName as string);
  const proposedAnyCampaigns = extractions
    .filter((e) => e.campaignName)
    .map((e) => e.campaignName as string);
  const proposed = proposedDmCampaigns.length ? proposedDmCampaigns : proposedAnyCampaigns;

  // Explicit type — Prisma's generated client may not yet have the latest
  // schema (regenerated at docker build time), so we don't rely on inference.
  const allCampaigns: Array<{ id: string; name: string }> = await prisma.campaign.findMany({
    where: { discordGuildId, active: true },
    select: { id: true, name: true }
  });

  let resolvedCampaignId: string | null = knownCampaignId ?? null;
  if (!resolvedCampaignId && proposed.length > 0) {
    const matches = allCampaigns.filter((c) => proposed.some((p) => fuzzyMatches(c.name, p)));
    const unique = Array.from(new Set(matches.map((m) => m.id)));
    if (unique.length === 1) {
      resolvedCampaignId = unique[0]!;
    } else if (unique.length > 1) {
      return {
        success: false,
        reason: 'campaign name matched multiple active campaigns',
        diagnostics: {
          proposed,
          matched: matches.map((m) => m.name)
        }
      };
    }
  }
  if (!resolvedCampaignId) {
    return {
      success: false,
      reason: 'no campaign name detected in any track\'s intro',
      diagnostics: {
        proposed,
        knownCampaigns: allCampaigns.map((c) => c.name)
      }
    };
  }

  // 2. DM resolution. Exactly one isDm=true track is the happy path.
  // A knownDmUserId (admin-supplied via /tag-session) short-circuits detection.
  const dmCandidates = extractions.filter((e) => e.isDm && e.userId);
  let dmUserId: string | null = knownDmUserId ?? null;
  if (dmUserId) {
    // already resolved
  } else if (dmCandidates.length === 1) {
    dmUserId = dmCandidates[0]!.userId!;
  } else if (dmCandidates.length > 1) {
    // Prefer the candidate with the highest confidence
    const best = dmCandidates.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    if (best.confidence >= 0.75) {
      dmUserId = best.userId!;
    } else {
      return {
        success: false,
        reason: 'multiple tracks self-identified as DM and confidence is too low to choose',
        diagnostics: {
          dmCandidates: dmCandidates.map((c) => ({
            userId: c.userId,
            characterName: c.characterName,
            confidence: c.confidence
          }))
        }
      };
    }
  } else {
    // No DM declared. Fall back to most recent DM for this campaign.
    const lastSession = await prisma.session.findFirst({
      where: { campaignId: resolvedCampaignId, dmUserId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { dmUserId: true }
    });
    if (lastSession?.dmUserId) {
      dmUserId = lastSession.dmUserId;
    } else {
      return {
        success: false,
        reason: 'no DM declared and no prior session for this campaign to fall back on',
        diagnostics: { campaignId: resolvedCampaignId }
      };
    }
  }

  // At this point dmUserId is non-null (we returned early in every branch
  // where it would stay null). Capture into a const so TS narrows it.
  const resolvedDmUserId: string = dmUserId;

  // 3. Per-track character resolution.
  const characters: Array<{ id: string; userId: string; name: string }> =
    await prisma.character.findMany({
      where: { campaignId: resolvedCampaignId },
      select: { id: true, userId: true, name: true }
    });
  const charactersByUser = new Map<string, Array<{ id: string; name: string }>>();
  for (const c of characters) {
    const list = charactersByUser.get(c.userId) ?? [];
    list.push({ id: c.id, name: c.name });
    charactersByUser.set(c.userId, list);
  }

  const sessionPlayers: ReconciliationSuccess['sessionPlayers'] = [];
  for (const e of extractions) {
    if (!e.userId) continue; // unknown speaker — can't write a SessionPlayer row
    const isThisDm = e.userId === resolvedDmUserId;
    if (isThisDm) {
      sessionPlayers.push({
        userId: e.userId,
        characterId: null,
        role: 'DM',
        trackIndex: e.trackIndex,
        detectedFromVoice: e.isDm
      });
      continue;
    }

    // Player track: try to resolve character.
    const candidates = charactersByUser.get(e.userId) ?? [];
    let characterId: string | null = null;
    let detectedFromVoice = false;

    if (e.characterName) {
      const match = candidates.find((c) => fuzzyMatches(c.name, e.characterName as string));
      if (match) {
        characterId = match.id;
        detectedFromVoice = true;
      }
    }
    if (!characterId) {
      // Fall back: most recently used character for this user in this campaign.
      const lastSp = await prisma.sessionPlayer.findFirst({
        where: {
          userId: e.userId,
          session: { campaignId: resolvedCampaignId },
          characterId: { not: null }
        },
        orderBy: { session: { createdAt: 'desc' } },
        select: { characterId: true }
      });
      if (lastSp?.characterId) {
        characterId = lastSp.characterId;
        detectedFromVoice = false;
      }
    }

    sessionPlayers.push({
      userId: e.userId,
      characterId,
      role: 'PLAYER',
      trackIndex: e.trackIndex,
      detectedFromVoice
    });
  }

  return {
    success: true,
    campaignId: resolvedCampaignId,
    dmUserId: resolvedDmUserId,
    sessionPlayers
  };
}
