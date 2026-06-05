// Wraps the vendored cook.sh as a child process.
//
// cook.sh contract (from Craig):
//   cook.sh <recordingId> <format> <container>
//   - Looks for <recordingId>.ogg.{data,header1,header2,users,info} in
//     "$SCRIPTBASE/rec" (we symlink that to /app/rec in the Dockerfile).
//   - Writes a zip archive to stdout containing per-track FLAC files
//     named "<NN>_<username>_<chapter>.<ext>" plus info.txt and raw.dat.
//
// We invoke it with format=flac, container=zip, capture stdout to a temp
// file, unzip into the chapter's output directory, then trim the noise
// files (info.txt, raw.dat). Filenames carry the 1-based track index in
// their leading numeric prefix, which we parse to map back to .ogg.users.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export interface CookedFile {
  trackIndex: number;
  filename: string;
  absolutePath: string;
  fileSizeBytes: number;
}

export interface CookResult {
  outputDir: string;
  files: CookedFile[];
  cookExitCode: number;
  cookStderr: string;
}

export interface CookOptions {
  /** Directory containing cook.sh (e.g. /app/vendor). */
  cookScriptDir: string;
  /** Basename used by cook.sh — must match raw files' `<id>.ogg.*` prefix. */
  recordingId: string;
  /** Where to extract per-track FLAC files. Created if absent. */
  outputDir: string;
  /** Hard kill after this many ms. */
  timeoutMs: number;
}

function runProcess(opts: {
  cmd: string;
  args: string[];
  stdoutFile?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.cmd, opts.args, {
      stdio: ['ignore', opts.stdoutFile ? 'pipe' : 'ignore', 'pipe'],
      env: opts.env ?? process.env
    });
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    if (opts.stdoutFile && child.stdout) {
      const out = createWriteStream(opts.stdoutFile);
      child.stdout.pipe(out);
      out.on('error', (e) => settle(() => reject(e)));
    }
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
      // Cap stderr at 8KB to avoid memory growth on noisy runs
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`${opts.cmd} timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);

    child.on('error', (e) => {
      clearTimeout(killTimer);
      settle(() => reject(e));
    });
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      settle(() => resolve({ code: code ?? -1, stderr }));
    });
  });
}

/**
 * Cook a chapter into per-track FLAC files.
 *
 * Returns the list of files actually produced (track index parsed from
 * filename prefix), along with the cook process's exit code and trailing
 * stderr for diagnostics.
 */
export async function cookChapter(opts: CookOptions): Promise<CookResult> {
  await mkdir(opts.outputDir, { recursive: true });
  const zipPath = path.join(opts.outputDir, '_cook.zip');

  // 1. Run cook.sh; stdout -> zip file
  const cook = await runProcess({
    cmd: 'sh',
    args: [path.join(opts.cookScriptDir, 'cook.sh'), opts.recordingId, 'flac', 'zip'],
    stdoutFile: zipPath,
    timeoutMs: opts.timeoutMs
  });
  if (cook.code !== 0) {
    return {
      outputDir: opts.outputDir,
      files: [],
      cookExitCode: cook.code,
      cookStderr: cook.stderr
    };
  }

  // 2. Verify the zip exists and is non-empty before unzipping
  const zipStat = await stat(zipPath).catch(() => null);
  if (!zipStat || zipStat.size === 0) {
    await rm(zipPath, { force: true });
    throw new Error(`cook.sh produced no output for recording ${opts.recordingId}`);
  }

  // 3. Unzip into outputDir
  const unzip = await runProcess({
    cmd: 'unzip',
    args: ['-o', '-q', zipPath, '-d', opts.outputDir],
    timeoutMs: Math.max(60_000, opts.timeoutMs / 4)
  });
  if (unzip.code !== 0) {
    throw new Error(`unzip exited ${unzip.code}: ${unzip.stderr.slice(-300)}`);
  }

  // 4. Tidy: remove the zip + the auxiliary files cook.sh always writes
  await rm(zipPath, { force: true });
  await rm(path.join(opts.outputDir, 'info.txt'), { force: true });
  await rm(path.join(opts.outputDir, 'raw.dat'), { force: true });

  // 5. List FLAC files; parse 1-based track index from filename prefix.
  const entries = await readdir(opts.outputDir);
  const files: CookedFile[] = [];
  for (const filename of entries) {
    if (!filename.endsWith('.flac')) continue;
    // cook.sh names files like "01_username_chapter.flac". Handle leading
    // zeros and missing user/chapter segments gracefully.
    const match = filename.match(/^(\d+)/);
    if (!match) continue;
    const trackIndex = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(trackIndex) || trackIndex <= 0) continue;
    const absolutePath = path.join(opts.outputDir, filename);
    const s = await stat(absolutePath);
    files.push({ trackIndex, filename, absolutePath, fileSizeBytes: s.size });
  }
  files.sort((a, b) => a.trackIndex - b.trackIndex);

  return {
    outputDir: opts.outputDir,
    files,
    cookExitCode: 0,
    cookStderr: cook.stderr
  };
}

/**
 * Compute the recording basename cook.sh wants — i.e. strip `.ogg.data`
 * from the chapter's raw data path. cook.sh derives the other file paths
 * by appending `.ogg.{header1,header2,users,info}`.
 */
export function recordingBasename(rawDataPath: string): string {
  return path.basename(rawDataPath, '.ogg.data');
}
