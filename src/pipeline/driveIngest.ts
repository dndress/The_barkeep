// Stage 6.5 — Google Drive transcript ingester.
//
// Workflow:
//   1. List subfolders inside the configured parent folder via Drive API v3.
//   2. For each subfolder whose name matches a known Session.recording_id
//      (and which is using external_whisper transcription), list .json
//      files in it.
//   3. For each JSON file, extract Discord username from the filename
//      (Chronicler's cook naming pattern), find the matching AudioFile
//      row for that session + user, download the JSON, parse it as
//      Whisper output, persist a Transcript row.
//
// Auth: a single Google Cloud API key (read-only Drive access). The
// folder is expected to be public ("anyone with the link can view"); for
// private folders we'd need OAuth, which we don't bother with here.
//
// All Drive failures are swallowed and logged — the worker is allowed to
// fall back to Gemini after 10 days regardless of Drive availability.
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db.js';
import { parseWhisperJsonString, extractDiscordUsernameFromCookFilename } from './whisperJson.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

interface ListFilesResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

async function driveListFolderChildren(
  parentId: string,
  apiKey: string,
  log: FastifyBaseLogger
): Promise<DriveFile[]> {
  const all: DriveFile[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', `'${parentId}' in parents and trashed = false`);
    url.searchParams.set('fields', 'nextPageToken, files(id, name, mimeType)');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('key', apiKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      log.warn({ status: res.status, body: body.slice(0, 300), parentId }, 'drive list failed');
      throw new Error(`drive list HTTP ${res.status}`);
    }
    const data: ListFilesResponse = await res.json();
    if (data.files) all.push(...data.files);
    if (!data.nextPageToken) return all;
    pageToken = data.nextPageToken;
  }
  return all;
}

async function driveDownloadFile(fileId: string, apiKey: string): Promise<string> {
  const url = `${DRIVE_API}/files/${fileId}?alt=media&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`drive download HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.text();
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface IngestReport {
  subfoldersInspected: number;
  sessionsTouched: number;
  transcriptsWritten: number;
  filesSkipped: number;
  errors: string[];
}

/**
 * Single Drive poll — list parent folder, walk subfolders, ingest matching
 * JSONs. Designed to be safe to invoke repeatedly: existing transcripts are
 * not overwritten, and missing AudioFile rows just cause the file to be
 * skipped (it'll be picked up on a later poll once the chapter has been
 * received and cooked).
 */
export async function pollDriveOnce(
  apiKey: string,
  parentFolderId: string,
  log: FastifyBaseLogger
): Promise<IngestReport> {
  const prisma = getPrisma();
  const report: IngestReport = {
    subfoldersInspected: 0,
    sessionsTouched: 0,
    transcriptsWritten: 0,
    filesSkipped: 0,
    errors: []
  };

  // 1. List subfolders.
  let children: DriveFile[];
  try {
    children = await driveListFolderChildren(parentFolderId, apiKey, log);
  } catch (err) {
    report.errors.push(`list parent: ${(err as Error).message}`);
    return report;
  }
  const subfolders = children.filter((f) => f.mimeType === FOLDER_MIME);

  for (const subfolder of subfolders) {
    report.subfoldersInspected += 1;

    // 2. Match subfolder name to a pending Session.recording_id.
    const recordingId = subfolder.name.trim();
    const session = await prisma.session.findUnique({
      where: { recordingId },
      include: {
        chapters: {
          include: {
            audioFiles: {
              select: { id: true, userId: true, trackIndex: true, transcript: true }
            }
          }
        }
      }
    });
    if (!session) {
      // No matching session — likely a future recording or unrelated folder.
      continue;
    }
    if (session.status === 'POSTED' || session.status === 'NEEDS_REVIEW' || session.status === 'FAILED') {
      continue;
    }

    // First time we look at this session — record so the 10/14-day timers start.
    if (!session.transcriptIngestFirstCheckedAt) {
      await prisma.session.update({
        where: { id: session.id },
        data: { transcriptIngestFirstCheckedAt: new Date() }
      });
    }

    // 3. List files in the subfolder.
    let filesInSession: DriveFile[];
    try {
      filesInSession = await driveListFolderChildren(subfolder.id, apiKey, log);
    } catch (err) {
      report.errors.push(`list ${recordingId}: ${(err as Error).message}`);
      continue;
    }

    let touchedThisSession = false;
    for (const file of filesInSession) {
      if (file.mimeType === FOLDER_MIME) continue;
      if (!file.name.toLowerCase().endsWith('.json')) {
        report.filesSkipped += 1;
        continue;
      }

      // 4. Match filename → user → AudioFile.
      const username = extractDiscordUsernameFromCookFilename(file.name);
      if (!username) {
        log.warn({ filename: file.name, recordingId }, 'cannot parse discord username from filename');
        report.filesSkipped += 1;
        continue;
      }
      // Try exact match first. discordUsername isn't @unique in the schema
      // (Discord usernames can technically be reassigned), so we findFirst.
      let dbUser = await prisma.user.findFirst({
        where: { discordUsername: username },
        select: { id: true, displayName: true }
      });
      // Fallback: normalize (lowercase + strip leading non-alphanumeric)
      // and compare. Catches cases where Chronicler's filename sanitization
      // drops a leading "." (e.g. ".dmorar" in the DB → "dmorar" in the
      // filename) and the reverse.
      if (!dbUser) {
        const normalize = (s: string): string =>
          s.toLowerCase().replace(/^[^a-z0-9]+/, '');
        const wanted = normalize(username);
        const all = await prisma.user.findMany({
          select: { id: true, displayName: true, discordUsername: true }
        });
        const match = all.find((u) => normalize(u.discordUsername) === wanted);
        if (match) {
          dbUser = { id: match.id, displayName: match.displayName };
          log.info(
            { filename: file.name, filenameUsername: username, dbUsername: match.displayName },
            'matched filename username via leading-char-stripped fallback'
          );
        }
      }
      if (!dbUser) {
        log.warn({ filename: file.name, username, recordingId }, 'no Barkeep user matches Discord username');
        report.filesSkipped += 1;
        continue;
      }

      // Find an AudioFile for this user across the session's chapters.
      const candidates = session.chapters
        .flatMap((c) => c.audioFiles)
        .filter((af) => af.userId === dbUser.id);
      if (candidates.length === 0) {
        // Chapters might not be in yet — skip and try next poll.
        log.info({ filename: file.name, recordingId }, 'no AudioFile yet for user; will retry');
        report.filesSkipped += 1;
        continue;
      }
      const target = candidates.find((af) => af.transcript === null);
      if (!target) {
        // Already transcribed — skip silently.
        continue;
      }

      // 5. Download + parse + persist.
      let body: string;
      try {
        body = await driveDownloadFile(file.id, apiKey);
      } catch (err) {
        report.errors.push(`download ${file.name}: ${(err as Error).message}`);
        continue;
      }
      let parsed: ReturnType<typeof parseWhisperJsonString>;
      try {
        parsed = parseWhisperJsonString(body);
      } catch (err) {
        report.errors.push(`parse ${file.name}: ${(err as Error).message}`);
        continue;
      }

      await prisma.$transaction([
        prisma.transcript.create({
          data: {
            audioFileId: target.id,
            fullText: parsed.fullText,
            segments: parsed.segments as unknown as object,
            language: parsed.language
          }
        }),
        // Defensive: prevent the Gemini transcribe drain from racing us if
        // someone flips the source mid-flight. Max attempts blocks retry.
        prisma.audioFile.update({
          where: { id: target.id },
          data: { transcribeAttempts: 999, transcribeError: null }
        })
      ]);
      report.transcriptsWritten += 1;
      touchedThisSession = true;
      log.info(
        {
          recordingId,
          username,
          audioFileId: target.id,
          charCount: parsed.fullText.length,
          segmentCount: parsed.segments.length
        },
        'whisper transcript ingested from drive'
      );
    }
    if (touchedThisSession) report.sessionsTouched += 1;
  }

  return report;
}
