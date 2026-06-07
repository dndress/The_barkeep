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
    `- short: a recap suitable for a Discord post. Target around ${opts.shortWordTarget} words. Capture the main events with enough detail that a returning player can tell what happened. Written in ${lang}.`,
    `- full: a detailed narrative recap. No length cap — scale to the session. This is the Barkeep's memory bank for later player questions; include specific NPC names, locations, decisions, and dialogue quotes. Written in ${lang}.`,
    `- key_events: AT MOST ${opts.keyEventsTarget} structured events. Each has:`,
    '    - description: one sentence, what happened',
    '    - characters_involved: array of character names (use the labels in the transcript). Use "DM" if the DM is centrally involved.',
    '    - importance: 1 (trivial) to 10 (campaign-defining)',
    '- character_memories: notable per-character items the Barkeep should remember about each named character. Each has:',
    '    - characterName: exact label from the transcript',
    '    - kind: one of deed / quote / relationship / wound / quirk',
    '    - content: one sentence',
    '    - importance: 1 (trivial) to 10 (campaign-defining)',
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
      }
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
  const characterNames = Array.from(new Set(lines.map((l) => l.speaker)));
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
