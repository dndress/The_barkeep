// Stage 8 — parser for the combined chronological transcript produced by
// the external whisper pipeline (combined_<recording_id>.txt in the Drive
// subfolder). Format, one utterance per line:
//
//   [00:00:13.4100] DM: del pueblito y un enano llega como corriendo...
//   [00:00:20.6800] Cuervo: corriendo, lo saludamos, lo saludamos...
//
// Speaker labels are character names (or "DM") — identity resolution
// already happened upstream when the file was built, so we take labels
// as-is. Lines that don't match the timestamp pattern are treated as
// continuations of the previous utterance.

export interface CombinedSegment {
  /** Seconds from session start. */
  startSec: number;
  speaker: string;
  text: string;
}

export interface ParsedCombinedTranscript {
  segments: CombinedSegment[];
  /** Distinct speaker labels in order of first appearance. */
  speakers: string[];
}

// [HH:MM:SS], [HH:MM:SS.m…], [H:MM:SS.m…] — fractional seconds optional,
// any number of digits.
const LINE = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?\]\s*([^:]{1,80}):\s?(.*)$/;

export function parseCombinedTranscript(raw: string): ParsedCombinedTranscript {
  const segments: CombinedSegment[] = [];
  const speakers: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const m = LINE.exec(line);
    if (!m) {
      // Continuation of the previous utterance (wrapped line).
      const prev = segments[segments.length - 1];
      if (prev) prev.text += ' ' + line.trim();
      continue;
    }

    const hours = Number.parseInt(m[1]!, 10);
    const minutes = Number.parseInt(m[2]!, 10);
    const seconds = Number.parseInt(m[3]!, 10);
    const frac = m[4] ? Number.parseFloat(`0.${m[4]}`) : 0;
    const startSec = hours * 3600 + minutes * 60 + seconds + frac;

    const speaker = m[5]!.trim();
    const text = m[6]!.trim();
    if (!speaker) continue;

    segments.push({ startSec, speaker, text });
    if (!seen.has(speaker)) {
      seen.add(speaker);
      speakers.push(speaker);
    }
  }

  return { segments, speakers };
}
