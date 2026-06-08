// Stage 7.5 — Drive write client.
//
// When a Chronicler webhook arrives for an external_whisper session, we
// also need to:
//   1. Ensure a "pending/" subfolder exists in the configured Drive parent.
//   2. Create a per-session subfolder named with the recording_id.
//   3. Write a small text manifest into pending/ so N8N can pick it up
//      and kick off Kaggle → faster-whisper → upload back to the subfolder.
//
// Auth: a Google Cloud service account. Pass the JSON key as
// GOOGLE_SERVICE_ACCOUNT_JSON env (the entire JSON, single line). Share
// the parent Drive folder with the SA's email so it has write access.
//
// We use google-auth-library for the JWT/token handling but call the
// Drive REST API directly via fetch — keeps the dep surface small.
import { JWT } from 'google-auth-library';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const TEXT_MIME = 'text/plain';

let _jwt: JWT | null | undefined;

function loadServiceAccountClient(): JWT | null {
  if (_jwt !== undefined) return _jwt;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || raw.trim().length === 0) {
    _jwt = null;
    return null;
  }
  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    _jwt = null;
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    _jwt = null;
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing client_email or private_key');
  }
  _jwt = new JWT({
    email: parsed.client_email,
    key: parsed.private_key,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  return _jwt;
}

export function isDriveWriteConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

async function getAccessToken(): Promise<string> {
  const jwt = loadServiceAccountClient();
  if (!jwt) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured');
  }
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error('failed to obtain Drive access token');
  return token;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

async function listChildren(parentId: string, query: string): Promise<DriveFile[]> {
  const token = await getAccessToken();
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', `'${parentId}' in parents and trashed = false and ${query}`);
  url.searchParams.set('fields', 'files(id, name, mimeType)');
  url.searchParams.set('pageSize', '100');
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`drive list HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

async function createFolder(parentId: string, name: string): Promise<DriveFile> {
  const token = await getAccessToken();
  const res = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId]
    })
  });
  if (!res.ok) {
    throw new Error(`drive create folder HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as DriveFile;
}

/**
 * Find or create the "pending" subfolder under the parent. Caches the
 * result in module scope so repeated calls don't re-list Drive.
 */
let _pendingFolderCache: { parentId: string; pendingId: string } | undefined;
export async function ensurePendingFolder(parentId: string): Promise<string> {
  if (_pendingFolderCache?.parentId === parentId) return _pendingFolderCache.pendingId;
  const existing = await listChildren(
    parentId,
    `name = 'pending' and mimeType = '${FOLDER_MIME}'`
  );
  let pendingId: string;
  if (existing.length > 0) {
    pendingId = existing[0]!.id;
  } else {
    pendingId = (await createFolder(parentId, 'pending')).id;
  }
  _pendingFolderCache = { parentId, pendingId };
  return pendingId;
}

/**
 * Find or create the per-session subfolder. Returns the folder ID. The
 * folder is created at the top level (sibling to "pending"), NOT inside
 * it — N8N expects pending/<recording_id>.txt to point at a sibling
 * subfolder where transcripts should be uploaded.
 */
export async function ensureSessionSubfolder(
  parentId: string,
  recordingId: string
): Promise<{ id: string; url: string }> {
  const existing = await listChildren(
    parentId,
    `name = '${recordingId.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}'`
  );
  let folderId: string;
  if (existing.length > 0) {
    folderId = existing[0]!.id;
  } else {
    folderId = (await createFolder(parentId, recordingId)).id;
  }
  return {
    id: folderId,
    url: `https://drive.google.com/drive/folders/${folderId}`
  };
}

interface SessionManifestInput {
  recordingId: string;
  subfolderId: string;
  subfolderUrl: string;
  startedAt: Date;
  endedAt: Date | null;
}

function buildManifestContent(m: SessionManifestInput): string {
  return [
    `recording_id: ${m.recordingId}`,
    `folder_id: ${m.subfolderId}`,
    `folder_url: ${m.subfolderUrl}`,
    `started_at: ${m.startedAt.toISOString()}`,
    `ended_at: ${m.endedAt ? m.endedAt.toISOString() : ''}`
  ].join('\n');
}

/**
 * Write/replace the per-session manifest file under pending/. Drive
 * doesn't have a "PUT-by-name" upsert, so we delete a same-named file
 * first if present and then upload anew.
 */
export async function writeSessionManifest(
  parentFolderId: string,
  manifest: SessionManifestInput
): Promise<{ fileId: string }> {
  const pendingId = await ensurePendingFolder(parentFolderId);
  const fileName = `${manifest.recordingId}.txt`;

  // Delete prior copy if present so we don't accumulate duplicates.
  const existing = await listChildren(
    pendingId,
    `name = '${fileName.replace(/'/g, "\\'")}' and mimeType = '${TEXT_MIME}'`
  );
  if (existing.length > 0) {
    const token = await getAccessToken();
    for (const f of existing) {
      await fetch(`${DRIVE_API}/files/${f.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
    }
  }

  // Multipart upload: one metadata part + one body part.
  const boundary = `bk-${Date.now()}`;
  const metadata = {
    name: fileName,
    mimeType: TEXT_MIME,
    parents: [pendingId]
  };
  const body = buildManifestContent(manifest);
  const multipart = [
    `--${boundary}`,
    `Content-Type: application/json; charset=UTF-8`,
    ``,
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${TEXT_MIME}; charset=UTF-8`,
    ``,
    body,
    `--${boundary}--`
  ].join('\r\n');

  const token = await getAccessToken();
  const res = await fetch(
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipart
    }
  );
  if (!res.ok) {
    throw new Error(`drive upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const created = (await res.json()) as { id: string; name: string };
  return { fileId: created.id };
}
