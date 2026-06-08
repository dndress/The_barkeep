// Vector retrieval over the chunks table, campaign-scoped.
//
// We use pgvector's cosine-distance operator <=>; lower is more similar.
// Result rows include enough metadata to build the persona prompt and
// (Stage 8 maybe) the footer that says "the Barkeep recalls N sessions".
import { getPrisma } from '../db.js';

export interface RetrievedChunk {
  id: string;
  sessionId: string;
  characterId: string | null;
  source: string;
  text: string;
  distance: number;
}

export interface SearchOptions {
  campaignId: string;
  queryEmbedding: number[];
  topK: number;
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

export async function ragSearch(opts: SearchOptions): Promise<RetrievedChunk[]> {
  const prisma = getPrisma();
  // Raw query because Prisma doesn't model the vector operator. We CAST
  // the literal to ::vector inside the query.
  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT c.id, c.session_id AS "sessionId", c.character_id AS "characterId",
           c.source::text AS source, c.text,
           (c.embedding <=> $1::vector) AS distance
    FROM chunks c
    JOIN sessions s ON s.id = c.session_id
    WHERE s.campaign_id = $2
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1::vector
    LIMIT $3
    `,
    vectorLiteral(opts.queryEmbedding),
    opts.campaignId,
    opts.topK
  )) as RetrievedChunk[];
  return rows;
}

/**
 * Count how many sessions in a campaign currently have embedded chunks —
 * used in the /ask reply footer ("recalls tales from N sessions").
 */
export async function countEmbeddedSessions(campaignId: string): Promise<number> {
  const prisma = getPrisma();
  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT COUNT(DISTINCT c.session_id)::int AS n
    FROM chunks c
    JOIN sessions s ON s.id = c.session_id
    WHERE s.campaign_id = $1
    `,
    campaignId
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
