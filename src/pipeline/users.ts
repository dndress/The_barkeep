// Parser for Chronicler's `.ogg.users` sidecar.
//
// File format (per Craig's userinfo.js):
//   The file content is NOT itself a JSON document. It's a sequence of
//   "<n>: <obj>," lines that, when wrapped in `{}`, parse as a JSON object
//   keyed by 1-based track index. Older recordings instead produce a stream
//   that parses when wrapped in `[]` (a positional array). We try both.
//
// Each track entry looks like:
//   { "id": "<discord-snowflake>", "username": "...", "name": "...",
//     "discrim": 0 | "<4-digit>", ... }
//
// We extract the minimum we need to write AudioFile rows.
import { readFile } from 'node:fs/promises';

export interface OggUser {
  /** 1-based track index, matching what cook.sh emits in filenames. */
  trackIndex: number;
  /** Discord snowflake. Missing on very old recordings. */
  discordUserId?: string;
  /** Current Discord @username at recording time. Display only. */
  discordUsername?: string;
  /** Server nickname / display name. */
  discordDisplayName?: string;
}

interface RawUserEntry {
  id?: unknown;
  username?: unknown;
  name?: unknown;
}

function coerceString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function entryToUser(trackIndex: number, raw: RawUserEntry | null | undefined): OggUser | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    trackIndex,
    discordUserId: coerceString(raw.id),
    discordUsername: coerceString(raw.username),
    discordDisplayName: coerceString(raw.name)
  };
}

export async function parseOggUsers(filePath: string): Promise<OggUser[]> {
  const content = (await readFile(filePath, 'utf8')).trim();
  if (!content) return [];

  // Try object-wrap first (modern format)
  let parsedObject: Record<string, RawUserEntry> | null = null;
  try {
    parsedObject = JSON.parse('{' + content + '}');
  } catch {
    parsedObject = null;
  }
  if (parsedObject) {
    const users: OggUser[] = [];
    for (const [k, v] of Object.entries(parsedObject)) {
      const idx = Number.parseInt(k, 10);
      if (!Number.isFinite(idx)) continue;
      const u = entryToUser(idx, v);
      if (u) users.push(u);
    }
    users.sort((a, b) => a.trackIndex - b.trackIndex);
    return users;
  }

  // Old positional format: [<u1>, <u2>, ...]
  let parsedArray: Array<RawUserEntry | null> | null = null;
  try {
    parsedArray = JSON.parse('[' + content + ']');
  } catch {
    parsedArray = null;
  }
  if (parsedArray) {
    const users: OggUser[] = [];
    parsedArray.forEach((entry, i) => {
      // Craig's array form is 0-indexed; cook.sh emits 1-based filenames.
      // We normalize to 1-based here.
      const u = entryToUser(i + 1, entry);
      if (u) users.push(u);
    });
    return users;
  }

  throw new Error(`unable to parse .ogg.users file: ${filePath}`);
}
