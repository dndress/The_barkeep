// Build the Barkeep persona system prompt for /ask.
//
// The prompt has three jobs:
//   1. Establish the character (a weathered tavern keeper).
//   2. Anchor on the asker (their character name + class/race).
//   3. Frame retrieved chunks as "things the bards have told me" so the
//      model treats them as second-hand source material rather than
//      ground truth it must repeat verbatim.
import type { RetrievedChunk } from './ragSearch.js';

export interface PersonaContext {
  campaignName: string;
  campaignLanguageHint: string; // e.g. 'es'
  campaignPersonaFlavor: string | null;
  asker: {
    characterName: string | null;
    race: string | null;
    classOrRole: string | null;
    displayName: string;
  };
  retrieved: RetrievedChunk[];
}

const SOURCE_LABEL: Record<string, string> = {
  transcript: "a fragment of conversation overheard at the table",
  summary_short: "a bard's quick recap",
  summary_full: "a bard's detailed account",
  key_event: "a notable moment recorded by a passing scribe",
  character_memory: "a story whispered about a known adventurer"
};

export function buildBarkeepSystemPrompt(ctx: PersonaContext): string {
  const lang = ctx.campaignLanguageHint === 'es' ? 'Spanish' : ctx.campaignLanguageHint;
  const askerLabel =
    ctx.asker.characterName ??
    `the traveler called ${ctx.asker.displayName}`;
  const askerKind = [ctx.asker.race, ctx.asker.classOrRole].filter(Boolean).join(' ').trim();
  const flavorLine = ctx.campaignPersonaFlavor
    ? `\nYour personal flavor: ${ctx.campaignPersonaFlavor}.`
    : '';

  const header = [
    `You are the Barkeep — a weathered keeper of an old tavern who hears the deeds of adventuring parties from the bards who frequent your establishment.`,
    `You speak primarily in ${lang}, weaving in English for proper nouns (character names, spell names, class names, places) when the bards used them.${flavorLine}`,
    ``,
    `You are speaking with **${askerLabel}**${askerKind ? `, ${askerKind}` : ''}. Address them by that name throughout your reply.`,
    ``,
    `What follows are fragments the bards have told me about past sessions of **${ctx.campaignName}**.`,
    `Use them to inform your reply but DO NOT quote them verbatim — paraphrase, dramatize, weave them into your voice.`,
    `If the truth of the question does not appear in these fragments, say so honestly. Invent nothing. A barkeep's pride is in knowing what they don't know.`,
    `Keep your reply concise — three short paragraphs at most. End with a small flourish, as a tavern keeper would.`,
    ``,
    `--- FRAGMENTS ---`
  ].join('\n');

  const fragments = ctx.retrieved
    .map((c, i) => {
      const label = SOURCE_LABEL[c.source] ?? 'a fragment';
      return `[${i + 1}] (${label}) ${c.text}`;
    })
    .join('\n\n');

  return `${header}\n${fragments}\n--- END FRAGMENTS ---`;
}
