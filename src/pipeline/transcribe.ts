// Single-AudioFile transcription against the Gemini File API.
//
// Flow:
//   1. Upload the cooked FLAC.
//   2. Poll until the uploaded file's state is ACTIVE (usually a few seconds).
//   3. Call gemini-2.5-flash with the file + a Spanish-primary prompt.
//   4. Extract response text.
//   5. Delete the uploaded file regardless of success/failure (we have a 48h
//      auto-expiry as a safety net, but explicit cleanup is friendlier to
//      the player's free-tier File API storage quota).
//
// On any failure we throw — the caller (worker.ts) catches, increments
// transcribeAttempts, stores the error, and decides whether to retry.
import { createPartFromUri, createUserContent } from '@google/genai';
import path from 'node:path';

import { getGemini } from './gemini.js';

export interface TranscribeOptions {
  /** Absolute path to the FLAC file on disk. */
  filePath: string;
  /** Model id, e.g. 'gemini-2.5-flash'. */
  model: string;
  /** Two-letter primary language hint (e.g. 'es'). Embedded into the prompt. */
  languageHint: string;
  /** Hard cap on total time across upload + poll + generate, in ms. */
  timeoutMs: number;
}

export interface TranscribeResult {
  /** Full transcript text — no speaker labels, no timestamps, no commentary. */
  text: string;
  /** Gemini response id for audit / debugging. */
  responseId?: string;
  /** Detected language code if Gemini returns one in usage metadata. */
  language?: string;
}

const FLAC_MIME = 'audio/flac';

function buildPrompt(languageHint: string): string {
  // System-prompt style content. The audio comes immediately before this
  // text in the request, so "this audio" refers unambiguously to the file.
  return [
    'Transcribe the audio above verbatim.',
    '',
    'Context:',
    `- The primary spoken language is ${languageHint === 'es' ? 'Spanish' : languageHint}.`,
    '- Some words are in English: character names, spell names, monster names,',
    '  D&D / Pathfinder mechanics terms, and direct character-sheet readouts.',
    '- The speaker is one player in a tabletop RPG session — only their voice is on this track.',
    '',
    'Output rules:',
    '- Output ONLY the transcript text. Nothing else.',
    '- No speaker labels (no "Player:" or names).',
    '- No timestamps.',
    '- No "[inaudible]" or similar — if a segment is unclear, transcribe your best guess.',
    '- Preserve the original language of each word. Do not translate.',
    '- Use standard punctuation.',
    '- If the audio is silent or contains no speech, output an empty string and nothing else.'
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
    // Exponential-ish backoff capped at 5s to avoid hammering the API.
    delay = Math.min(delay * 2, 5000);
  }
}

/**
 * Upload, transcribe, and tear down. Throws on any failure step.
 */
export async function transcribeAudioFile(opts: TranscribeOptions): Promise<TranscribeResult> {
  const ai = getGemini();
  const displayName = path.basename(opts.filePath);

  // 1. Upload
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
    // 2. Wait for ACTIVE
    await waitForActive(fileName, Math.min(60_000, opts.timeoutMs / 4));

    if (!fileUri) {
      throw new Error(`Gemini File API uploaded file ${fileName} has no URI after becoming ACTIVE`);
    }

    // 3. Generate
    const response = await ai.models.generateContent({
      model: opts.model,
      contents: [
        createUserContent([
          createPartFromUri(fileUri, FLAC_MIME),
          buildPrompt(opts.languageHint)
        ])
      ],
      config: {
        // Verbatim transcription should not "hallucinate" plausible text.
        // Temperature 0 + no topP/topK gives the model the least room to
        // get creative.
        temperature: 0
      }
    });

    const text = (response.text ?? '').trim();
    const responseId =
      (response as unknown as { responseId?: string }).responseId ??
      (response as unknown as { id?: string }).id;

    return {
      text,
      responseId,
      // The SDK doesn't expose a language field directly; we rely on the
      // hint we passed in. Future: extract from usageMetadata if available.
      language: opts.languageHint
    };
  } finally {
    // 4. Always try to delete the uploaded file. Failure to delete is
    // non-fatal (48h auto-expiry will catch it), but we log via thrown
    // suppression so the worker can decide.
    try {
      await ai.files.delete({ name: fileName });
    } catch {
      // Swallowed — the cleanup attempt failing doesn't change the
      // transcription outcome and we don't want to mask a real error
      // from the generateContent call above.
    }
  }
}
