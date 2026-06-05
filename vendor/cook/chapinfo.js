#!/usr/bin/env node
// Reads <id>.ogg.info and prints the chapter+timestamp segment used in
// per-track filenames inside zip downloads. Output is exactly one of:
//   ch<N>_YYYYMMDD_HHMM   (chaptered recording)
//   YYYYMMDD_HHMM         (non-chaptered recording)
//   (empty)               (info file missing/unreadable — caller falls back)
// Used by cook.sh to assemble names like 01_username_ch1_20260603_1530.flac
const fs = require('fs');

const id = process.argv[2];
if (!id) {
  process.exit(1);
}

let info;
try {
  info = JSON.parse(fs.readFileSync(`${id}.ogg.info`, 'utf8'));
} catch (e) {
  // Info missing or malformed — emit nothing and let cook.sh skip the segment.
  process.stdout.write('');
  process.exit(0);
}

const pad = (n) => String(n).padStart(2, '0');
let out = '';
try {
  const d = new Date(info.startTime);
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const chapter = info.chapter && typeof info.chapter.number === 'number' ? `ch${info.chapter.number}_` : '';
  out = `${chapter}${ts}`;
} catch (e) {
  out = '';
}

process.stdout.write(out);
