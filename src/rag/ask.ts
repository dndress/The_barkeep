// Orchestrator: take a question + context → return Rikk's reply.
//
// Used by the /ask slash command. Steps:
//   1. Embed the question.
//   2. ragSearch against the campaign's chunks (top-K).
//   3. Resolve the asker's character from their Discord ID via SessionPlayer.
//   4. Build persona prompt + call gemini-2.5-pro.
//   5. Return text + simple metadata (sessions touched, etc.) for the
//      embed footer.
import { getPrisma } from '../db.js';
import { getGemini } from '../pipeline/gemini.js';
import { embedOne } from '../pipeline/embedder.js';
import { buildBarkeepSystemPrompt } from './persona.js';
import { countEmbeddedSessions, ragSearch } from './ragSearch.js';

export interface AskOptions {
  discordUserId: string;
  discordChannelId: string;
  question: string;
  embedModel: string;
  askModel: string;
  topK: number;
  embedTimeoutMs: number;
  askTimeoutMs: number;
}

export interface AskResult {
  ok: true;
  reply: string;
  campaignName: string;
  embeddedSessions: number;
  retrievedCount: number;
}

export interface AskFailure {
  ok: false;
  reason: string;
  userFacing: string;
}

export async function ask(opts: AskOptions): Promise<AskResult | AskFailure> {
  const prisma = getPrisma();

  // 1. Channel → campaign.
  const campaign = await prisma.campaign.findUnique({
    where: { discordTextChannelId: opts.discordChannelId },
    select: { id: true, name: true, personaFlavor: true }
  });
  if (!campaign) {
    return {
      ok: false,
      reason: 'channel_not_campaign',
      userFacing:
        'I only tell tales here when the channel is tied to a campaign. Try this in a campaign channel.'
    };
  }

  // 2. Asker identity → character (most recent SessionPlayer in this campaign).
  const user = await prisma.user.findUnique({
    where: { discordUserId: opts.discordUserId },
    select: { id: true, displayName: true }
  });
  let askerCharacter: { name: string; race: string | null; classOrRole: string | null } | null =
    null;
  if (user) {
    const recent = await prisma.sessionPlayer.findFirst({
      where: {
        userId: user.id,
        session: { campaignId: campaign.id },
        characterId: { not: null }
      },
      orderBy: { session: { createdAt: 'desc' } },
      include: { character: { select: { name: true, race: true, classOrRole: true } } }
    });
    if (recent?.character) askerCharacter = recent.character;
  }

  // 3. Embed the question + search.
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedOne(opts.question, {
      model: opts.embedModel,
      timeoutMs: opts.embedTimeoutMs
    });
  } catch {
    return {
      ok: false,
      reason: 'embed_failed',
      userFacing: 'Rikk is occupied with another matter at the moment. Try again shortly.'
    };
  }

  const retrieved = await ragSearch({
    campaignId: campaign.id,
    queryEmbedding,
    topK: opts.topK
  });

  if (retrieved.length === 0) {
    return {
      ok: false,
      reason: 'no_chunks',
      userFacing:
        "The chant has carried me nothing yet about this party, cutter. Return once the accounts have arrived."
    };
  }

  const embeddedSessions = await countEmbeddedSessions(campaign.id);

  // 4. Persona prompt + Gemini call.
  const systemPrompt = buildBarkeepSystemPrompt({
    campaignName: campaign.name,
    campaignLanguageHint: 'es',
    campaignPersonaFlavor: campaign.personaFlavor,
    asker: {
      characterName: askerCharacter?.name ?? null,
      race: askerCharacter?.race ?? null,
      classOrRole: askerCharacter?.classOrRole ?? null,
      displayName: user?.displayName ?? 'unknown cutter'
    },
    retrieved
  });

  const ai = getGemini();
  let reply: string;
  try {
    const response = (await Promise.race([
      ai.models.generateContent({
        model: opts.askModel,
        contents: [
          { role: 'user', parts: [{ text: systemPrompt }] },
          { role: 'user', parts: [{ text: `Question: ${opts.question}` }] }
        ],
        config: {
          temperature: 0.7
        }
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`ask timed out after ${opts.askTimeoutMs}ms`)),
          opts.askTimeoutMs
        )
      )
    ])) as { text?: string };
    reply = (response.text ?? '').trim();
    if (!reply) throw new Error('empty reply');
  } catch {
    return {
      ok: false,
      reason: 'generate_failed',
      userFacing: "Rikk's thoughts are elsewhere just now. Ask again shortly."
    };
  }

  return {
    ok: true,
    reply,
    campaignName: campaign.name,
    embeddedSessions,
    retrievedCount: retrieved.length
  };
}
