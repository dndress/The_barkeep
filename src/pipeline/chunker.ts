// Chunker for embedding ingestion.
//
// Splits long text into ~400-token chunks. We don't have a real tokenizer
// in this image — pulling one in (e.g. tiktoken) for a hobby pipeline is
// overkill. Instead we use a chars-per-token heuristic of ~4 and pick
// chunk boundaries at sentence ends, falling back to character boundaries
// only as a last resort.
//
// Caller-facing API:
//   - chunkTranscriptSegments: walks (speaker, segment[]) and produces
//     chunks of ~400 tokens, each preserving speaker labels and the
//     timestamp of the FIRST segment in the chunk.
//   - chunkLongText: generic prose splitter for summaries.
//   - chunkRow: small wrapper for one-line content (character memories,
//     key events) that should never be split.
const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 400;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

export interface TranscriptSegmentForChunking {
  /** Seconds since chapter start. */
  start: number;
  text: string;
}

export interface TranscriptChunkInput {
  speakerLabel: string;
  /** Chronological segments belonging to this speaker. */
  segments: TranscriptSegmentForChunking[];
  /** Absolute wall-clock millisecond offset of the chapter that owns these. */
  chapterStartedAtMs?: number;
}

export interface TextChunk {
  text: string;
  tokenCount: number;
  tsStartSec: number;
  tsEndSec: number;
}

/** Round-down estimate. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Concatenate a speaker's transcript into chunks of ~TARGET_CHARS,
 * preserving the speaker label on each line. The boundary preference is
 * end-of-sentence; we never break mid-word.
 */
export function chunkTranscriptSegments(input: TranscriptChunkInput): TextChunk[] {
  const chunks: TextChunk[] = [];
  let buf = '';
  let bufStart = 0;
  let bufEnd = 0;
  let bufHasContent = false;

  const flush = (): void => {
    const text = buf.trim();
    if (!text) return;
    chunks.push({
      text,
      tokenCount: estimateTokens(text),
      tsStartSec: Math.floor(bufStart),
      tsEndSec: Math.floor(bufEnd)
    });
    buf = '';
    bufHasContent = false;
  };

  for (const seg of input.segments) {
    const line = `${input.speakerLabel}: ${seg.text.trim()}\n`;
    if (!bufHasContent) {
      bufStart = seg.start;
    }
    bufEnd = seg.start;

    if (buf.length + line.length > TARGET_CHARS && bufHasContent) {
      flush();
      bufStart = seg.start;
    }
    buf += line;
    bufHasContent = true;
  }
  flush();
  return chunks;
}

/**
 * Generic prose splitter. Walks at sentence boundaries (periods,
 * question marks, exclamation marks). Never breaks inside a sentence
 * unless the sentence itself exceeds TARGET_CHARS.
 */
export function chunkLongText(text: string): TextChunk[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  if (cleaned.length <= TARGET_CHARS) {
    return [{ text: cleaned, tokenCount: estimateTokens(cleaned), tsStartSec: 0, tsEndSec: 0 }];
  }

  // Split into rough sentences. Keep delimiters attached.
  const sentenceRegex = /[^.!?¡¿]+[.!?¡¿]+\s*|\S+\s*$/g;
  const sentences = cleaned.match(sentenceRegex) ?? [cleaned];

  const out: TextChunk[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length > TARGET_CHARS && buf.length > 0) {
      const t = buf.trim();
      out.push({ text: t, tokenCount: estimateTokens(t), tsStartSec: 0, tsEndSec: 0 });
      buf = '';
    }
    buf += s;
  }
  const tail = buf.trim();
  if (tail) {
    out.push({ text: tail, tokenCount: estimateTokens(tail), tsStartSec: 0, tsEndSec: 0 });
  }
  return out;
}

/**
 * Wrap a short piece of text (one character memory, one key_event) as a
 * single chunk. Doesn't split — these are meant to be retrieved whole.
 */
export function chunkRow(text: string): TextChunk[] {
  const t = text.trim();
  if (!t) return [];
  return [{ text: t, tokenCount: estimateTokens(t), tsStartSec: 0, tsEndSec: 0 }];
}
