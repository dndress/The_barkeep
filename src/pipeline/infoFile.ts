// Stage 8 — parser for Craig's info.txt (uploaded to the Drive subfolder
// alongside the whisper JSONs).
//
// We care about two sections:
//   Tracks:  — one indented line per recorded track:
//                <username>#<disc> (<discord snowflake>)
//   Notes:   — indented "<h:mm:ss>: <payload>" lines. The roster note's
//              payload is a list separated by LITERAL "\n" sequences
//              (backslash + n, as Craig renders it) or real newlines:
//                <system> - <campaign name>
//                <username>: DM
//                <username>: <character name>
//                ...
//
// The parser is deliberately tolerant: tabs or spaces for indentation,
// \r\n line endings, "#0" discriminators present or absent, multiple
// notes (we pick the first one that looks like a roster).
//
// Matching against the DB happens elsewhere (worker) — this module only
// turns text into structure.

export interface InfoTrack {
  username: string;
  discordUserId: string;
}

export interface InfoRosterEntry {
  /** Discord username exactly as written in the note (no #disc). */
  username: string;
  /** Character name, or null when the entry marks the DM. */
  characterName: string | null;
  isDm: boolean;
}

export interface InfoRoster {
  /** Raw campaign segment, e.g. "PF2E - Hellknight Hill". */
  campaignRaw: string;
  entries: InfoRosterEntry[];
}

export interface ParsedInfoFile {
  recordingId: string | null;
  tracks: InfoTrack[];
  roster: InfoRoster | null;
}

/**
 * Normalize a Discord username for comparison: lowercase, strip a
 * trailing "#1234" discriminator, strip leading non-alphanumerics
 * (".dmorar" → "dmorar", "_danielgallego" → "danielgallego").
 */
export function normalizeUsername(s: string): string {
  return s
    .toLowerCase()
    .replace(/#\d+$/, '')
    .replace(/^[^a-z0-9]+/, '')
    .trim();
}

const TRACK_LINE = /^\s+(.+?)\s+\((\d{15,21})\)\s*$/;
const NOTE_LINE = /^\s+(\d+:\d{2}:\d{2}(?:\.\d+)?):\s*(.*)$/;
const RECORDING_LINE = /^Recording\s+(\S+)/i;

/**
 * Split a note payload into entries. Craig renders embedded newlines as
 * the literal two-character sequence "\n"; if the file was rewritten by
 * another tool they may be real newlines instead. Accept both.
 */
function splitNotePayload(payload: string): string[] {
  return payload
    .split(/\\n|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Try to interpret one note payload as a roster. Returns null when the
 * payload doesn't look like one (needs a campaign line plus at least one
 * "username: value" pair).
 */
function parseRosterFromPayload(payload: string): InfoRoster | null {
  const parts = splitNotePayload(payload);
  if (parts.length < 2) return null;

  // First segment is the campaign line. Accept two forms:
  //   (a) bare:     "PF2E - Hellknight Hill"
  //   (b) labeled:  "Campaign: PF2E - Hellknight Hill"  (Craig newer info.txt)
  // Strip the label so downstream sees "PF2E - Hellknight Hill" either way.
  let campaignRaw = parts[0]!;
  if (!campaignRaw) return null;
  const labeled = /^(?:campaign|campa[ñn]a|campaign\s*name)\s*:\s*(.+)$/i.exec(campaignRaw);
  if (labeled) campaignRaw = labeled[1]!.trim();
  // After (optional) label strip, the line must NOT itself be a "name: value"
  // pair (would be ambiguous with a roster entry).
  if (!campaignRaw || /^\S+\s*:/.test(campaignRaw)) return null;

  const entries: InfoRosterEntry[] = [];
  for (const part of parts.slice(1)) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue; // not a pair — ignore stray text
    const username = part.slice(0, idx).trim().replace(/#\d+$/, '');
    const value = part.slice(idx + 1).trim();
    if (!username || !value) continue;
    const isDm = /^(dm|gm|dungeon\s*master|game\s*master)$/i.test(value);
    entries.push({
      username,
      characterName: isDm ? null : value,
      isDm
    });
  }
  if (entries.length === 0) return null;
  return { campaignRaw, entries };
}

export function parseInfoFile(raw: string): ParsedInfoFile {
  const lines = raw.split(/\r?\n/);

  let recordingId: string | null = null;
  const tracks: InfoTrack[] = [];
  let roster: InfoRoster | null = null;

  type Section = 'none' | 'tracks' | 'notes';
  let section: Section = 'none';

  for (const line of lines) {
    if (!line.trim()) continue;

    const recMatch = RECORDING_LINE.exec(line);
    if (recMatch) {
      recordingId = recMatch[1]!;
      section = 'none';
      continue;
    }
    if (/^Tracks:\s*$/i.test(line)) {
      section = 'tracks';
      continue;
    }
    if (/^Notes:\s*$/i.test(line)) {
      section = 'notes';
      continue;
    }
    // Any other non-indented "Header:" line ends the current section.
    if (/^\S/.test(line)) {
      section = 'none';
      continue;
    }

    if (section === 'tracks') {
      const m = TRACK_LINE.exec(line);
      if (m) {
        tracks.push({
          username: m[1]!.replace(/#\d+$/, '').trim(),
          discordUserId: m[2]!
        });
      }
      continue;
    }

    if (section === 'notes' && !roster) {
      const m = NOTE_LINE.exec(line);
      const payload = m ? m[2]! : line.trim();
      roster = parseRosterFromPayload(payload);
    }
  }

  return { recordingId, tracks, roster };
}
