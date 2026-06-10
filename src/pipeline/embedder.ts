// Gemini embedding wrapper (default: gemini-embedding-001). Used for both:
//   - bulk ingestion of session content (transcripts, summary, memories)
//   - single-query embedding when /ask runs
//
// We batch where possible — Gemini supports embedding multiple texts in
// one request via embedContents — to keep latency + per-request overhead
// down during session ingestion. For a single /ask query we just embed
// one string.
//
// gemini-embedding-001 defaults to 3072 dims; our `chunks.embedding` is
// vector(768), so we pin outputDimensionality=768 via MRL truncation.
// Non-3072 outputs are NOT unit-normalized, so we normalize client-side
// for consistency with prior text-embedding-004 vectors and to keep
// cosine search well-conditioned.
import { getGemini } from './gemini.js';

const DEFAULT_BATCH_SIZE = 100;
const EMBED_DIMS = 768;

function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export interface EmbedOptions {
  model: string;
  timeoutMs: number;
}

interface EmbedResponseEmbedding {
  values?: number[];
}

interface BatchResponseShape {
  embeddings?: EmbedResponseEmbedding[];
}

/**
 * Embed a single text. Used by /ask to embed the user's question.
 */
export async function embedOne(text: string, opts: EmbedOptions): Promise<number[]> {
  const out = await embedBatch([text], opts);
  if (out.length !== 1 || !out[0]) {
    throw new Error('embedOne: empty response');
  }
  return out[0];
}

/**
 * Embed a batch of texts. Slices into chunks of DEFAULT_BATCH_SIZE to
 * stay safely within Gemini's per-request input cap. Returns vectors in
 * the same order as inputs.
 */
export async function embedBatch(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ai = getGemini();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += DEFAULT_BATCH_SIZE) {
    const slice = texts.slice(i, i + DEFAULT_BATCH_SIZE);
    const response = (await Promise.race([
      ai.models.embedContent({
        model: opts.model,
        contents: slice.map((t) => ({ role: 'user', parts: [{ text: t }] })),
        config: { outputDimensionality: EMBED_DIMS }
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`embedBatch timed out after ${opts.timeoutMs}ms`)),
          opts.timeoutMs
        )
      )
    ])) as BatchResponseShape;

    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== slice.length) {
      throw new Error(
        `embedBatch: expected ${slice.length} embeddings, got ${embeddings.length}`
      );
    }
    for (const e of embeddings) {
      if (!e.values || e.values.length === 0) {
        throw new Error('embedBatch: empty values in embedding');
      }
      if (e.values.length !== EMBED_DIMS) {
        throw new Error(
          `embedBatch: expected ${EMBED_DIMS}-dim vector, got ${e.values.length}`
        );
      }
      out.push(l2Normalize(e.values));
    }
  }
  return out;
}
