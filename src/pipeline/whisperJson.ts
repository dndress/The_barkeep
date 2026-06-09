// Parser for OpenAI Whisper / faster-whisper JSON output.
//
// Whisper's `--output_format json` produces something like:
//   {
//     "text": "Hola, soy Andrés...",
//     "segments": [
//       { "id": 0, "seek": 0, "start": 0.0, "end": 5.2, "text": "Hola..." },
//       ...
//     ],
//     "language": "es"
//   }
//
// faster-whisper has nearly the same shape (no `seek`, sometimes extra
// fields like `words`). We only need `start` and `text` per segment, plus
// the top-level `language` if present. We're permissive about extra keys.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type { TranscribeSegment } from './transcribe.js';

const SegmentSchema = z
  .object({
    start: z.number().nonnegative().finite(),
    text: z.string()
  })
  .passthrough();

// We accept two shapes from Whisper-style pipelines:
//   1. OpenAI Whisper native:   { segments: [...], language: "es", text: "..." }
//   2. Bare array (faster-whisper-style export):  [ {start, end, text, confidence}, ... ]
// `confidence` and other extra fields are ignored via passthrough.
const ObjectShape = z
  .object({
    segments: z.array(SegmentSchema),
    language: z.string().optional(),
    text: z.string().optional()
  })
  .passthrough();
const ArrayShape = z.array(SegmentSchema);
const WhisperJsonSchema = z.union([ObjectShape, ArrayShape]);

export interface ParsedWhisperOutput {
  segments: TranscribeSegment[];
  fullText: string;
  language?: string;
}

export function parseWhisperJsonString(content: string): ParsedWhisperOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`whisperJson: not valid JSON: ${(e as Error).message}`);
  }
  const validated = WhisperJsonSchema.safeParse(raw);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`whisperJson: schema validation failed: ${issues}`);
  }

  // Normalize: both shapes feed into the same segments-array path. We use
  // Array.isArray inline so TS narrows the union in each branch.
  interface RawSeg { start: number; text: string }
  let rawSegments: RawSeg[];
  let declaredLanguage: string | undefined;
  let declaredText: string | undefined;
  if (Array.isArray(validated.data)) {
    rawSegments = validated.data;
    declaredLanguage = undefined;
    declaredText = undefined;
  } else {
    rawSegments = validated.data.segments;
    declaredLanguage = validated.data.language;
    declaredText = validated.data.text;
  }

  const segments: TranscribeSegment[] = rawSegments
    .map((s: RawSeg) => ({ start: s.start, text: s.text.trim() }))
    .filter((s: TranscribeSegment) => s.text.length > 0)
    .sort((a: TranscribeSegment, b: TranscribeSegment) => a.start - b.start);

  const fullText =
    declaredText?.trim() || segments.map((s) => s.text).join(' ');

  return {
    segments,
    fullText,
    language: declaredLanguage
  };
}

export async function parseWhisperJsonFile(filePath: string): Promise<ParsedWhisperOutput> {
  const content = await readFile(filePath, 'utf8');
  return parseWhisperJsonString(content);
}

/**
 * Extract a Discord username from a Chronicler-style cook filename.
 * Cook emits names like "<track>_<username>_<chapter_meta>.<ext>" — we
 * grab everything between the FIRST and LAST underscore. This handles
 * usernames that start with an underscore (e.g. "_danielgallego") which
 * a plain split('_') would mangle into an empty middle element.
 *
 * Returns null when the filename doesn't have at least two underscores
 * (in which case it isn't a Chronicler cook output).
 */
export function extractDiscordUsernameFromCookFilename(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  const base = dot === -1 ? filename : filename.slice(0, dot);
  const first = base.indexOf('_');
  const last = base.lastIndexOf('_');
  if (first === -1 || first === last) return null;
  const username = base.slice(first + 1, last).trim();
  if (!username) return null;
  return username;
}
