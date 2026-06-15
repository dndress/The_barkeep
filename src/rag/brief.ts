// Per-character pre-session brief generator.
//
// Pulled by the /brief admin command. For each character in a campaign,
// we assemble a focused dossier — recent session summaries, that
// character's own memories, key_events the character was involved in —
// and ask Gemini to produce a short pre-session DM in Rikk's voice.
//
// Why no RAG embeddings here:
//   - The data we need is already structured (summaries, memories, events).
//   - One brief per character per call is cheap; embeddings would buy us
//     nothing for a top-down "what should you remember?" prompt.
//   - Determinism: the dossier is the SAME inputs every time, so two
//     /brief runs in a row produce comparable outputs (good for debugging).
import type { PrismaClient } from '@prisma/client';

import { getGemini } from '../pipeline/gemini.js';

export interface CharacterBriefOptions {
  prisma: PrismaClient;
  campaignId: string;
  characterId: string;
  model: string;
  languageHint: string; // 'es' etc.
  timeoutMs: number;
  /** How many of the most recent sessions to draw context from. */
  recentSessionsToInclude: number;
  /** How many of the character's memories to include (most recent first). */
  memoriesToInclude: number;
}

export interface CharacterBriefResult {
  text: string;
  characterName: string;
  /** True when we had so little material the brief is generic. */
  sparse: boolean;
}

interface KeyEventLike {
  description: string;
  characters_involved: string[];
  importance: number;
}

export async function buildCharacterBrief(
  opts: CharacterBriefOptions
): Promise<CharacterBriefResult> {
  const { prisma } = opts;

  // 1. Character + campaign basics.
  const character = await prisma.character.findUniqueOrThrow({
    where: { id: opts.characterId },
    select: {
      id: true,
      name: true,
      race: true,
      classOrRole: true,
      personality: true,
      campaign: { select: { name: true, personaFlavor: true } }
    }
  });

  // 2. Recent sessions in this campaign (most recent first).
  const recentSessions = await prisma.session.findMany({
    where: {
      campaignId: opts.campaignId,
      summary: { isNot: null }
    },
    orderBy: { startedAt: 'desc' },
    take: opts.recentSessionsToInclude,
    select: {
      id: true,
      sessionNumber: true,
      startedAt: true,
      summary: { select: { short: true, full: true, keyEvents: true } }
    }
  });

  // 3. This character's memories, most important + most recent.
  const memories = await prisma.characterMemory.findMany({
    where: { characterId: opts.characterId, archived: false },
    orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
    take: opts.memoriesToInclude,
    select: { kind: true, content: true, importance: true }
  });

  // 4. Filter key_events from recent sessions to ones this character was
  //    actually involved in. Lets us anchor the brief on lived experiences,
  //    not general party history.
  const characterKeyEvents: Array<{ sessionNumber: number | null; ev: KeyEventLike }> = [];
  for (const s of recentSessions) {
    if (!s.summary) continue;
    const evs: KeyEventLike[] = Array.isArray(s.summary.keyEvents)
      ? (s.summary.keyEvents as unknown as KeyEventLike[])
      : [];
    for (const ev of evs) {
      if ((ev.characters_involved ?? []).includes(character.name)) {
        characterKeyEvents.push({ sessionNumber: s.sessionNumber, ev });
      }
    }
  }

  // 5. Decide if the dossier is too thin to produce a useful brief.
  const sparse =
    recentSessions.length === 0 &&
    memories.length === 0 &&
    characterKeyEvents.length === 0;

  // 6. Build the prompt for Gemini. Rikk's voice carries over from
  //    persona.ts but is restated inline to avoid coupling.
  const lang =
    opts.languageHint === 'es'
      ? 'neutral Latin American Spanish (español neutro latinoamericano)'
      : opts.languageHint;
  const flavor = character.campaign.personaFlavor
    ? `\nYour personal flavor for this campaign: ${character.campaign.personaFlavor}.`
    : '';

  const recentBlock = recentSessions
    .slice()
    .reverse() // chronological for readability
    .map((s) => {
      const num = s.sessionNumber != null ? `Session ${s.sessionNumber}` : 'A recent session';
      return `${num}:\n${s.summary?.full ?? s.summary?.short ?? ''}`;
    })
    .join('\n\n---\n\n');

  const memoryBlock = memories
    .map((m) => `- (${m.kind.toLowerCase()}, importance ${m.importance}/10) ${m.content}`)
    .join('\n');

  const eventBlock = characterKeyEvents
    .map((x) => {
      const sn = x.sessionNumber != null ? `S${x.sessionNumber}` : '?';
      return `- [${sn}] ${x.ev.description}`;
    })
    .join('\n');

  const kind = [character.race, character.classOrRole].filter(Boolean).join(' ').trim();
  const characterLabel = kind ? `${character.name} (${kind})` : character.name;
  const campaignName = character.campaign.name;

  const promptHeader = [
    `You are Rikk — an analytical wizard aligned with the Fraternity of Order. Calm, observant, precise. Measured sentences. Dry humor or subtle irony. You exist as a real person in the world; never break the fourth wall.${flavor}`,
    ``,
    `You speak primarily in ${lang}, weaving in English for proper nouns (character names, spell names, class names, places) when the chant carried them in English.`,
    ``,
    `SPANISH DIALECT — strict:`,
    `- Use ONLY neutral Latin American Spanish. Never Peninsular / Castilian Spanish.`,
    `- FORBIDDEN: "vosotros" and every conjugation derived from it (habéis, tenéis, sois, estáis, hacéis, podéis, vais, "id", "venid", "esperad"). Use "ustedes" + 3rd-person-plural verbs.`,
    `- FORBIDDEN Spain-specific slang: "vale", "tío", "tía", "joder", "hostia", "guay", "molar", "currar", "chaval", "flipar", "majo", "venga ya", "coño", "gilipollas", "cojonudo", "tronco", "chulo".`,
    `- Keep the register sober, literate, neutral — readable across Latin America without sounding foreign.`,
    `- Sigil cant (berk, cutter, the chant, dark, Prime, hardhead, blood) stays in ENGLISH and is the ONLY non-neutral flavor permitted.`,
    ``,
    `This brief concerns ONE specific affair: **${campaignName}**. Every word you write must be about ${characterLabel}'s dealings inside that affair, nothing else. Do not refer to other tales, parties, or affairs you may know of.`,
    ``,
    `You are about to send a PRIVATE message to **${characterLabel}** ahead of their next gathering with the party in **${campaignName}**. Address them directly and by name. No greeting like "Dear Rikk" — they are the recipient, not the sender.`,
    ``,
    `The message must include, in this order:`,
    `1. A brief grounding line — where ${character.name} stood at the end of the last gathering in ${campaignName} (location, immediate situation).`,
    `2. Open threads — unresolved questions, pending promises, lingering plot hooks from ${campaignName} specifically relevant to ${character.name}.`,
    `3. People to remember — NPCs from ${campaignName} who matter to ${character.name} and why (allies, foes, debts, suspicions).`,
    `4. A closing observation in Rikk's voice — one sentence of dry analysis or a small unanswered question to think about.`,
    ``,
    `Rules:`,
    `- Length: ~250 words, no more.`,
    `- IN-WORLD only. Never mention "the DM", "the GM", players, rolls, checks, HP, AC, rules, sessions, or anything out-of-fiction.`,
    `- Refer to ${character.name} by that exact spelling. Refer to other party members by their character names if relevant; do not reveal real-world names.`,
    `- Do NOT mention the campaign by its title in your reply — speak of it as the present world ("the affair we are about", "your current course", "the path you walk"). The title is for YOUR orientation only.`,
    `- If the dossier below is thin or empty, say so honestly in Rikk's voice ("the chant is light on you this turn") rather than inventing detail.`,
    `- Use NPC names exactly as they appear in the dossier. Do not transliterate or guess.`,
    `- No bracketed citations, footnotes, or source markers. The dossier is your memory, not a bibliography.`,
    ``,
    `--- DOSSIER: ${character.name.toUpperCase()} IN ${campaignName.toUpperCase()} ---`,
    ``,
    `Character: ${characterLabel}${character.personality ? ` — Personality: ${character.personality}` : ''}`,
    `Affair: ${campaignName}`,
    ``,
    `Recent session narratives from ${campaignName} (oldest → newest):`,
    recentBlock || '(none on record)',
    ``,
    `Key incidents in ${campaignName} involving ${character.name}:`,
    eventBlock || '(none on record)',
    ``,
    `Standing memories about ${character.name} (from ${campaignName} only):`,
    memoryBlock || '(none on record)',
    ``,
    `--- END DOSSIER ---`
  ].join('\n');

  // 7. Call Gemini.
  const ai = getGemini();
  const response = (await Promise.race([
    ai.models.generateContent({
      model: opts.model,
      contents: [{ role: 'user', parts: [{ text: promptHeader }] }],
      config: { temperature: 0.6 }
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`brief generation timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs
      )
    )
  ])) as { text?: string };

  const text = (response.text ?? '').trim();
  if (!text) {
    throw new Error('brief: empty model reply');
  }
  return { text, characterName: character.name, sparse };
}
