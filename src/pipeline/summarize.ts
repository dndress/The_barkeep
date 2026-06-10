// Chronological summary + character memory extraction.
//
// We do the heavy lifting in TypeScript first, NOT in the model:
//   1. Pull every Transcript's segments out of the DB.
//   2. Convert each segment's per-chapter `start` (seconds from chapter
//      start) into an absolute Date using chapter.startedAt + start.
//   3. Resolve each track to its character name (the Barkeep addresses
//      players by character, so labels are character-only).
//   4. Merge all segments across all tracks by absolute time → a single
//      chronological text with [HH:MM:SS] markers and character labels.
//   5. Send that interleaved text to gemini-2.5-flash and ask for a
//      structured JSON with short summary + full summary + key events +
//      per-character notable memories.
//
// All summarization happens in one Gemini call. ~180K tokens × $0.30/M =
// ~$0.05 per session.
import { Type } from '@google/genai';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { parseCombinedTranscript } from './combinedTranscript.js';
import { getGemini } from './gemini.js';

export interface SummarizeOptions {
  prisma: PrismaClient;
  sessionId: string;
  model: string;
  languageHint: string;
  /** Target word count for the short summary. */
  shortWordTarget: number;
  /** Max key events to ask Gemini for. */
  keyEventsTarget: number;
  /** Hard timeout for the Gemini call. */
  timeoutMs: number;
}

export interface KeyEvent {
  description: string;
  characters_involved: string[];
  importance: number;
}

export interface CharacterMemoryDraft {
  characterName: string;
  kind: 'deed' | 'quote' | 'relationship' | 'wound' | 'quirk';
  content: string;
  importance: number;
}

export interface SummarizeResult {
  short: string;
  full: string;
  keyEvents: KeyEvent[];
  characterMemories: CharacterMemoryDraft[];
  /** The interleaved transcript that was sent to Gemini. Useful for debug. */
  interleavedTranscript: string;
}

interface TranscriptSegment {
  start: number;
  text: string;
}

const SegmentSchema = z.object({
  start: z.number().nonnegative().finite(),
  text: z.string()
});

const SummaryResponseSchema = z.object({
  short: z.string().min(1),
  full: z.string().min(1),
  key_events: z.array(
    z.object({
      description: z.string(),
      characters_involved: z.array(z.string()),
      importance: z.number().int().min(1).max(10)
    })
  ),
  character_memories: z.array(
    z.object({
      characterName: z.string(),
      kind: z.enum(['deed', 'quote', 'relationship', 'wound', 'quirk']),
      content: z.string(),
      importance: z.number().int().min(1).max(10)
    })
  )
});

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function formatClock(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

interface InterleavedLine {
  absoluteTs: number;
  speaker: string;
  text: string;
}

function buildPrompt(opts: {
  languageHint: string;
  shortWordTarget: number;
  keyEventsTarget: number;
  characterNames: string[];
}): string {
  const lang = opts.languageHint === 'es' ? 'Spanish' : opts.languageHint;
  return [
    `You will receive a chronologically interleaved transcript of one tabletop RPG session, written in ${lang} with occasional English (proper nouns, spell names, mechanics terms).`,
    'Each line is labeled with the character name speaking (or "DM" for the dungeon master).',
    '',
    'Produce JSON matching the supplied schema with four fields:',
    '',
    `- short: an IN-WORLD recap suitable for a Discord post, written in the voice of RIKK (see RIKK VOICE below). Target around ${opts.shortWordTarget} words. Capture the main events with enough detail that a returning party member can reconstruct what occurred. Written in ${lang}. Follow the IMMERSION RULES and the RIKK VOICE rules below.`,
    `- full: a detailed IN-WORLD narrative recap in RIKK's voice — Rikk reviewing the chant and recounting the affair to the party. No length cap — scale to the session. Include specific NPC names, locations, decisions, and in-character dialogue. Written in ${lang}. Follow the IMMERSION RULES and the RIKK VOICE rules below.`,
    `- key_events: AT MOST ${opts.keyEventsTarget} structured events. Each has:`,
    '    - description: one sentence, what happened',
    '    - characters_involved: array of character names (use the labels in the transcript). Use "DM" if the DM is centrally involved.',
    '    - importance: 1 (trivial) to 10 (campaign-defining)',
    '- character_memories: notable per-character items to remember about each named character. Each has:',
    '    - characterName: exact label from the transcript',
    '    - kind: one of deed / quote / relationship / wound / quirk',
    '    - content: one sentence',
    '    - importance: 1 (trivial) to 10 (campaign-defining)',
    '',
    'RIKK VOICE (apply ONLY to `short` and `full`):',
    '- Rikk is an analytical wizard aligned with the Fraternity of Order. Calm, observant, precise. Measured sentences. Dry humor or subtle irony surfaces occasionally — never slapstick.',
    '- Worldview: every system has rules, even hidden ones. Rikk notices structures, motivations, contradictions, and consequences. When recounting events he favors cause-and-effect over breathless drama.',
    '- He may sparingly use Sigil cant (the chant, berk, cutter, dark, Prime, hardhead, blood). Use it with intent, not as ornament. A short recap may contain none; a full recap rarely more than a handful.',
    '- He acknowledges uncertainty when the chant is thin or contradictory — phrases like "the chant on this point is muddled" or "what came back was incomplete" — rather than inventing detail.',
    '- He refers to the party with respect and a faint analytical distance. Affection for them shows through attention to their decisions and their consequences, not declarations.',
    '- He does NOT moralize, monologue about philosophy, or lecture. He recounts. Reflection is brief and embedded in the narration.',
    '- Avoid modern slang, meme language, therapy language, and assistant phrasing ("certainly", "I hope this helps", "let me explain", "as an analysis").',
    '',
    'IMMERSION RULES (apply ONLY to `short` and `full` — NOT to key_events or character_memories):',
    '- Write as an in-world storyteller recounting events that truly happened. Never break the fourth wall.',
    '- NEVER mention "the DM", "the GM", "the dungeon master", "the player(s)", "the party rolled", or that anyone is playing a character or running a game.',
    '- NEVER mention dice, rolls, checks, saves, DCs, modifiers, Hero Points, AC, HP, hit points, damage numbers, levels, initiative, advantage/disadvantage, or any other rules/mechanics terminology. Translate mechanics into fiction:',
    '    - "failed a Survival check to hide their tracks" → "their tracks betrayed them"',
    '    - "rolled high on Athletics" → "vaulted across with surprising ease"',
    '    - "took 12 damage" → "a wound that nearly felled them"',
    '    - "the DM explained the rules of Hero Points" → omit entirely; it is out-of-fiction',
    '- NEVER label characters with "(NPC)", "(PC)", or any meta tag. Every named being is simply a person in the world.',
    '- Refer to characters and NPCs by their in-world names only. Do not name the human players behind the characters.',
    '- If transcript lines come from the "DM" label, treat their narration as events that happened in the world — describe what occurred, not that someone described it.',
    '',
    'Rules:',
    '- Write narrative content in the session\'s primary language.',
    '- Use ONLY character names that appear as labels in the transcript. Do not invent characters.',
    `- Characters present this session: ${opts.characterNames.join(', ')}.`,
    '- Be specific. Avoid vague phrasing.',
    '- Output STRICT JSON. No prose outside the JSON.'
  ].join('\n');
}

export async function summarizeSession(opts: SummarizeOptions): Promise<SummarizeResult> {
  const { prisma, sessionId } = opts;

  // 1. Fetch everything we need to assemble the interleaved transcript.
  const session = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      chapters: {
        include: {
          audioFiles: {
            include: {
              user: { select: { id: true, displayName: true } },
              transcript: { select: { segments: true, fullText: true } }
            }
          }
        },
        orderBy: { chapterIndex: 'asc' }
      },
      sessionPlayers: {
        include: { character: { select: { id: true, name: true } } }
      },
      // Stage 8 — preferred summarization input when present.
      combinedTranscript: { select: { fullText: true } }
    }
  });

  // Map userId → character label for this session. Falls back to displayName,
  // then to "Speaker <trackIndex>" if even that is missing.
  const characterLabelByUser = new Map<string, string>();
  for (const sp of session.sessionPlayers) {
    if (sp.role === 'DM') {
      characterLabelByUser.set(sp.userId, 'DM');
    } else if (sp.character) {
      characterLabelByUser.set(sp.userId, sp.character.name);
    }
  }

  // Stage 8 fast path: the external pipeline already produced one
  // chronological transcript labeled by character name. Use it verbatim —
  // no interleaving needed. The per-track interleave below remains the
  // fallback (Gemini-transcription path, or combined file never arrived).
  if (session.combinedTranscript?.fullText) {
    const parsed = parseCombinedTranscript(session.combinedTranscript.fullText);
    if (parsed.segments.length > 0) {
      return await runSummaryModel({
        opts,
        interleavedTranscript: session.combinedTranscript.fullText,
        characterNames: parsed.speakers
      });
    }
  }

  // 2 + 3 + 4. Walk chapters → audioFiles → segments, project to absolute time.
  const lines: InterleavedLine[] = [];
  for (const chapter of session.chapters) {
    const chapterStartMs = chapter.startedAt.getTime();
    for (const af of chapter.audioFiles) {
      if (!af.transcript) continue;
      const speaker =
        (af.userId && characterLabelByUser.get(af.userId)) ||
        af.user?.displayName ||
        `Speaker ${af.trackIndex}`;
      const rawSegments = af.transcript.segments;
      // segments is Json; could be null or an array. Validate defensively.
      if (!Array.isArray(rawSegments)) {
        // Fallback: treat the whole fullText as one segment at the chapter start.
        if (af.transcript.fullText) {
          lines.push({
            absoluteTs: chapterStartMs,
            speaker,
            text: af.transcript.fullText
          });
        }
        continue;
      }
      for (const seg of rawSegments) {
        const parsed = SegmentSchema.safeParse(seg);
        if (!parsed.success) continue;
        const text = parsed.data.text.trim();
        if (!text) continue;
        lines.push({
          absoluteTs: chapterStartMs + parsed.data.start * 1000,
          speaker,
          text
        });
      }
    }
  }

  lines.sort((a, b) => a.absoluteTs - b.absoluteTs);
  if (lines.length === 0) {
    throw new Error(`summarize: session ${sessionId} has no transcript segments to summarize`);
  }

  const interleavedTranscript = lines
    .map((l) => `[${formatClock(new Date(l.absoluteTs))}] ${l.speaker}: ${l.text}`)
    .join('\n');

  // 5. Build prompt + call Gemini.
  return await runSummaryModel({
    opts,
    interleavedTranscript,
    characterNames: Array.from(new Set(lines.map((l) => l.speaker)))
  });
}

/**
 * Shared model invocation — takes a ready chronological transcript (either
 * the Stage 8 combined file or the legacy per-track interleave) and runs
 * the single summarization call.
 */
async function runSummaryModel(args: {
  opts: SummarizeOptions;
  interleavedTranscript: string;
  characterNames: string[];
}): Promise<SummarizeResult> {
  const { opts, interleavedTranscript, characterNames } = args;
  const prompt = buildPrompt({
    languageHint: opts.languageHint,
    shortWordTarget: opts.shortWordTarget,
    keyEventsTarget: opts.keyEventsTarget,
    characterNames
  });

  const ai = getGemini();
  const response = await Promise.race([
    ai.models.generateContent({
      model: opts.model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { text: '\n\n--- TRANSCRIPT START ---\n' + interleavedTranscript + '\n--- TRANSCRIPT END ---' }
          ]
        }
      ],
      config: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            short: { type: Type.STRING },
            full: { type: Type.STRING },
            key_events: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  description: { type: Type.STRING },
                  characters_involved: { type: Type.ARRAY, items: { type: Type.STRING } },
                  importance: { type: Type.NUMBER }
                },
                required: ['description', 'characters_involved', 'importance']
              }
            },
            character_memories: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  characterName: { type: Type.STRING },
                  kind: { type: Type.STRING },
                  content: { type: Type.STRING },
                  importance: { type: Type.NUMBER }
                },
                required: ['characterName', 'kind', 'content', 'importance']
              }
            }
          },
          required: ['short', 'full', 'key_events', 'character_memories']
        }
      }
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`summarize timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs
      )
    )
  ]);

  const rawText = response.text ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`summarize: non-JSON output: ${rawText.slice(0, 200)}`);
  }
  const validated = SummaryResponseSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`summarize: schema validation failed: ${issues}`);
  }

  // Post-trim key_events to the cap in case the model overshot.
  const trimmedEvents = validated.data.key_events.slice(0, opts.keyEventsTarget);

  return {
    short: validated.data.short,
    full: validated.data.full,
    keyEvents: trimmedEvents,
    characterMemories: validated.data.character_memories,
    interleavedTranscript
  };
}
