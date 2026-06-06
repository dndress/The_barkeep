// Single-AudioFile transcription against the Gemini File API, Stage 4.5.
//
// Difference from Stage 4: we now request structured JSON output containing
// per-utterance segments with timestamps, not just a flat text blob. This
// lets the Stage 5 summarizer interleave multiple tracks by wall-clock
// time and reconstruct chronological event order across speakers.
//
// Output schema (enforced via Gemini's responseSchema):
//   {
//     "segments": [
//       { "start": <number, seconds from chapter start>, "text": "<verbatim>" },
//       ...
//     ]
//   }
//
// Flow:
//   1. Upload the cooked FLAC.
//   2. Poll until ACTIVE.
//   3. Call gemini-2.5-flash with structured-output config.
//   4. Validate the JSON shape with zod.
//   5. Derive `fullText` by joining segment text with spaces.
//   6. Always delete the uploaded file.
import { createPartFromUri, createUserContent, Type } from '@google/genai';
import path from 'node:path';
import { z } from 'zod';

import { getGemini } from './gemini.js';

export interface TranscribeOptions {
  filePath: string;
  model: string;
  languageHint: string;
  timeoutMs: number;
}

export interface TranscribeSegment {
  /** Seconds from the start of the audio file, fractional allowed. */
  start: number;
  /** Verbatim transcript text for this utterance. */
  text: string;
}

export interface TranscribeResult {
  /** Joined text of all segments — used wherever we need a flat string. */
  fullText: string;
  /** Structured segments. May be empty if the audio had no detected speech. */
  segments: TranscribeSegment[];
  responseId?: string;
  language?: string;
}

const FLAC_MIME = 'audio/flac';

const SegmentSchema = z.object({
  start: z.number().nonnegative().finite(),
  text: z.string()
});
const ResponseSchema = z.object({
  segments: z.array(SegmentSchema)
});

function buildPrompt(languageHint: string): string {
  const langName = languageHint === 'es' ? 'Spanish' : languageHint;
  return [
    'Transcribe the audio above as a list of speech segments, in time order.',
    '',
    'Context:',
    `- Primary spoken language: ${langName}.`,
    '- Some words are English: character names, spell names, monster names,',
    '  D&D / Pathfinder mechanics terms, direct character-sheet readouts.',
    '- The audio contains exactly one speaker — only their voice is on this track.',
    '- There may be long silent gaps; do not invent speech for silence.',
    '',
    'Output format: JSON matching the supplied schema.',
    '- Each segment is one natural utterance (sentence or clear pause boundary).',
    '- `start` is the number of seconds from the beginning of THIS audio file.',
    '  Be accurate — derive from the audio, do not estimate from prose length.',
    '- `text` is the verbatim transcript for that segment.',
    '- Preserve original language per word — do NOT translate to English.',
    '- No speaker labels in `text`. No timestamps embedded in `text`.',
    '- Standard punctuation.',
    '- If a segment is unclear, transcribe your best guess (no [inaudible]).',
    '- If the file has no speech at all, return { "segments": [] }.'
  ].join('\n');
}

async function waitForActive(fileName: string, timeoutMs: number): Promise<void> {
  const ai = getGemini();
  const deadline = Date.now() + timeoutMs;
  let delay = 1000;
  for (;;) {
    const file = await ai.files.get({ name: fileName });
    if (file.state === 'ACTIVE') return;
    if (file.state === 'FAILED') {
      throw new Error(`Gemini File API marked file ${fileName} as FAILED`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Gemini File API file ${fileName} did not become ACTIVE within ${timeoutMs}ms (last state: ${file.state})`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 5000);
  }
}

function joinSegments(segments: TranscribeSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

/**
 * Upload, transcribe with structured timestamped output, tear down.
 * Throws on any failure.
 */
export async function transcribeAudioFile(opts: TranscribeOptions): Promise<TranscribeResult> {
  const ai = getGemini();
  const displayName = path.basename(opts.filePath);

  const uploaded = await ai.files.upload({
    file: opts.filePath,
    config: {
      mimeType: FLAC_MIME,
      displayName
    }
  });
  if (!uploaded.name) {
    throw new Error('Gemini File API returned an upload without a `name` — cannot proceed');
  }
  const fileName = uploaded.name;
  const fileUri = uploaded.uri;

  try {
    await waitForActive(fileName, Math.min(60_000, opts.timeoutMs / 4));
    if (!fileUri) {
      throw new Error(`Gemini File API uploaded file ${fileName} has no URI after becoming ACTIVE`);
    }

    const response = await ai.models.generateContent({
      model: opts.model,
      contents: [
        createUserContent([
          createPartFromUri(fileUri, FLAC_MIME),
          buildPrompt(opts.languageHint)
        ])
      ],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        // Constrain the model to the segments shape so we don't have to
        // defend against prose wrappers or markdown fences.
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            segments: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  start: { type: Type.NUMBER },
                  text: { type: Type.STRING }
                },
                required: ['start', 'text']
              }
            }
          },
          required: ['segments']
        }
      }
    });

    const rawText = response.text ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      const sample = rawText.slice(0, 300);
      throw new Error(
        `Gemini returned non-JSON output despite responseSchema. First 300 chars: ${sample}`
      );
    }

    const validated = ResponseSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`Gemini response failed schema validation: ${issues}`);
    }

    // Sort by start in case the model returned them out of order. Defensive
    // — usually they're already in order — but doesn't cost much.
    const segments = validated.data.segments
      .slice()
      .sort((a, b) => a.start - b.start);

    const fullText = joinSegments(segments);
    const responseId =
      (response as unknown as { responseId?: string }).responseId ??
      (response as unknown as { id?: string }).id;

    return {
      fullText,
      segments,
      responseId,
      language: opts.languageHint
    };
  } finally {
    try {
      await ai.files.delete({ name: fileName });
    } catch {
      // Non-fatal; auto-expires in 48h.
    }
  }
}
