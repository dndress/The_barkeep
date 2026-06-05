# Vendored from Craig (Chronicler)

The files here are copied from Craig (https://github.com/CraigChat/craig, ISC
license, copyright Yahweasel and contributors) at the version pinned by the
Chronicler fork (https://github.com/dndress/craig).

Purpose: bundle the audio "cook" step so Barkeep can produce per-track FLAC
files from raw Chronicler artifacts without depending on Chronicler being
up. Loose coupling — Chronicler can refactor without breaking us.

## What's in here

| Path | Source | Purpose |
|------|--------|---------|
| `cook.sh` | Craig root | Driver that orchestrates per-track encoding from raw `.ogg.data + headers` into a zip. We call this from `src/pipeline/cook.ts`. |
| `buildCook.sh` | Craig `scripts/buildCook.sh` | Trivial compile loop. We invoke it during `docker build`. |
| `cook/*.c, cook/crc32.h` | Craig `cook/` | C sources compiled by `buildCook.sh` into helper binaries (oggtracks, oggcorrect, oggduration, oggmultiplexer, oggstender, wavduration, extnotes). |
| `cook/*.js` | Craig `cook/` | Node.js helpers (chapinfo, recinfo, userinfo) read by `cook.sh`. |
| `cook/info.sh, cook/duration.sh` | Craig `cook/` | Small helpers `cook.sh` shells out to. |

## What's NOT in here

We deliberately skip everything Barkeep doesn't use:

- `cook/macosx/`, `cook/windows/` — cross-compiled ffmpeg/unzipsfx binaries for self-extracting downloads. Barkeep is Linux-only.
- `cook/avatars.sh`, `cook/powersfx.sh`, `cook/raw-partwise.sh`, `cook/jsonnotes.sh`, `cook/infotxt.sh` — formats and accessory outputs we don't produce.
- `cook/glower-*.svg`, `cook/aup-header.xml`, `cook/ffmpeg-lgpl21.txt`, `cook/ffmpeg-flags/` — avatar art and self-extractor metadata.

The Craig version pinned by Chronicler is what these files were copied from. If Chronicler bumps Craig, re-copy by hand and update this note.

## Updating

```sh
# From the project root, with the chronicler repo as a sibling directory:
CRAIG=../craig-master
cp "$CRAIG/cook.sh" vendor/cook.sh
cp "$CRAIG/scripts/buildCook.sh" vendor/buildCook.sh
for f in extnotes.c oggcorrect.c oggduration.c oggmultiplexer.c oggstender.c oggtracks.c wavduration.c crc32.h \
         chapinfo.js recinfo.js userinfo.js info.sh duration.sh; do
  cp "$CRAIG/cook/$f" "vendor/cook/$f"
done
```
