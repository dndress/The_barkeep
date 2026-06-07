// Per-track intro extraction.
//
// We send each player's full transcript to gemini-2.5-flash and ask:
//   "Anywhere in this transcript, did this speaker identify themselves,
//    name their character, or announce what game we're playing?"
//
// Because RPG sessions often start with several minutes of small talk, we
// don't restrict to the first N minutes — Gemini scans the whole track.
// Cost is still tiny: ~30K tokens per call × 6 tracks × $0.30/M = ~$0.05/session.
import { Type } from '@google/genai';
import { z } from 'zod';

import { getGemini } from './gemini.js';

export interface IntroExtractionResult {
  isDm: boolean;
  characterName: string | null;
  campaignName: string | null;
  /** 0–1, the model's self-reported confidence. Treat as advisory only. */
  confidence: number;
}

const ResultSchema = z.object({
  isDm: z.boolean(),
  characterName: z.string().nullable(),
  campaignName: z.string().nullable(),
  confidence: z.number().min(0).max(1)
});

const PROMPT = [
  'You are reading a transcript from one player at a tabletop RPG session.',
  'There may be a session intro where the speaker says who they are, what',
  'character they are playing, and (if this speaker is the DM) which game',
  'or adventure is being run. The intro is usually near the start but can',
  'appear anywhere — chitchat often delays it.',
  '',
  'From the transcript, extract:',
  '- isDm: true if the speaker indicates they are the DM tonight (e.g. "soy',
  '  el DM hoy", "estoy dirigiendo", "I\'m DMing"). Otherwise false.',
  '- characterName: the proper-noun character the speaker says they are',
  '  playing (e.g. "Cuervo", "Caelis Wardfall"). Null if the speaker is the',
  '  DM or never names a character.',
  '- campaignName: the campaign / adventure title the speaker announces',
  '  (only set when isDm = true, and only if they actually name it). Null',
  '  otherwise. Examples: "Hellknight Hill", "Drakar", "Curse of Strahd".',
  '- confidence: 0–1, your self-assessed confidence in the extraction.',
  '  Lower if you guessed; higher if the speaker said it explicitly.',
  '',
  'Output STRICT JSON matching the supplied schema. No prose.'
].join('\n');

export interface ExtractIntroOptions {
  /** The full text of one track\'s transcript. */
  transcript: string;
  /** Model id, e.g. \'gemini-2.5-flash\'. */
  model: string;
  /** Hard timeout for the API call. */
  timeoutMs: number;
}

export async function extractIntroFromTranscript(
  opts: ExtractIntroOptions
): Promise<IntroExtractionResult> {
  const ai = getGemini();
  // We don\'t pass any audio file here — just text. Cheap.
  const response = await Promise.race([
    ai.models.generateContent({
      model: opts.model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: PROMPT },
            { text: '\n\n--- TRANSCRIPT START ---\n' + opts.transcript + '\n--- TRANSCRIPT END ---' }
          ]
        }
      ],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isDm: { type: Type.BOOLEAN },
            characterName: { type: Type.STRING, nullable: true },
            campaignName: { type: Type.STRING, nullable: true },
            confidence: { type: Type.NUMBER }
          },
          required: ['isDm', 'characterName', 'campaignName', 'confidence']
        }
      }
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`extractIntro timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs
      )
    )
  ]);

  const rawText = response.text ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`extractIntro: non-JSON output: ${rawText.slice(0, 200)}`);
  }
  const validated = ResultSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`extractIntro: schema validation failed: ${issues}`);
  }
  return validated.data;
}
