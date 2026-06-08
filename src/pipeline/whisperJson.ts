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

  // Normalize: both shapes feed into the same segments-array path.
  const isArray = Array.isArray(validated.data);
  const rawSegments = isArray ? validated.data : validated.data.segments;
  const declaredLanguage = isArray ? undefined : validated.data.language;
  const declaredText = isArray ? undefined : validated.data.text;

  const segments: TranscribeSegment[] = rawSegments
    .map((s) => ({ start: s.start, text: s.text.trim() }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start);

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
 * Cook emits names like "01_dres7234_chapter_info.flac" — the username is
 * the second underscore-separated token. We ignore the chapter suffix.
 * Returns null on filenames that don't match.
 */
export function extractDiscordUsernameFromCookFilename(filename: string): string | null {
  // Strip extension first
  const dot = filename.lastIndexOf('.');
  const base = dot === -1 ? filename : filename.slice(0, dot);
  const parts = base.split('_');
  if (parts.length < 2) return null;
  // parts[0] is track number; parts[1] is username (alphanumeric/underscores per Chronicler's sanitization).
  // If parts[1] is missing or empty, bail.
  const username = parts[1]?.trim();
  if (!username) return null;
  return username;
}
