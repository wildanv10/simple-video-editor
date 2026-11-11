# Simple Video Editor

A small video editor that runs as a **desktop app** (Electron) and as a **web app** (any modern browser). Trim, split and join clips on a multi-line timeline, and export **without re-encoding** whenever possible. It opens straight into the editor: no home screen, no account, no project files, and nothing is ever uploaded. Your videos are processed on your own computer, in both versions.

## Highlights

- **Lossless and fast.** Clips are cut and joined by stream copy (`ffmpeg -c copy`): a fraction of a second and no quality loss.
- **Multi-line timeline.** Several lines (layers); a clip on a higher line covers the ones below it, and all audio is mixed. Trim, split, move, reorder, and drop clips inside, above or below any line.
- **Effects.** Fade in/out, speed (0.5x to 2x), volume and mute, per clip.
- **Handles odd files.** MPEG-TS from an HLS (`.m3u8`) download renamed to `.mp4`, AVI and FLV are remuxed automatically for preview and saved as a regular MP4.
- **Same editor on desktop, web and phone.** One code base; a layout for phones and tablets; Clipchamp-style panels.

## Quick start

You need Node.js 18 or newer.

```
npm install
```

**Desktop app**

```
npm start
```

ffmpeg is bundled through `ffmpeg-static`, so no separate install is needed.

**Web app**

```
npm run start:web
```

Then open <http://127.0.0.1:5180/>. This builds the static site into `dist-web/` and serves it locally.

## Using the editor

1. **Import media** (or drag files into the window). The first import is added to the timeline automatically.
2. **Add clips.** The **+** button on a thumbnail (or a double-click) puts the clip on a **new line** on top, starting at the playhead. You can also **drag** a thumbnail, or a clip from another line, and drop it:
   - in the middle of a lane: **inside that line**. It snaps to the end of the previous clip, the playhead or other clips; if the spot is taken it goes to the nearest free slot;
   - on the top or bottom edge of a lane, or in the gap between two lanes: a **new line** opens right above or below it (a purple bar shows where);
   - on the dashed strips at the very top or bottom: a new line above or below everything.
3. **Edit.** Drag a clip's left or right edge to trim it (other clips stay put), drag the clip to move it in time or to another line, and press `S` to split at the playhead. `Del` removes the selected clip and closes the gap on its line; `Shift+Del` leaves the gap (it exports as black, silent video).
4. **Settings.** Select a clip to open the **Clip** panel: exact trim times, fade in/out, speed and volume. A fade reveals the lines below it.
5. **Export.** There are no options: the app picks the fastest way that gives the result you built.

### Export: fast or slow

Clips are joined **without re-encoding** unless one of these applies:

| Re-encoding is only used when | How to keep it lossless |
|---|---|
| a clip has an **effect** (fade, speed, volume) | leave the effects off |
| clips **overlap in time** on different lines | put them one after another; which line a clip is on does not matter |
| there is a **gap** between clips | close the gap (`Del` does it for you) |
| clips use **different formats** (codec, profile, size, frame rate rounded to a whole number, audio) | use clips from the same source or with the same settings |

While exporting, the app says which method it is using and, for a re-encode, exactly why. A re-encode keeps the size of the first clip on the lowest line and the highest source frame rate (up to 60 fps), and writes H.264 + AAC in an MP4. It is much slower: on a 6-core desktop, 1080p re-encodes at roughly 5 to 6 times real time, against about 200 times for a lossless join.

Lossless cuts can only start on a keyframe, so a clip may begin slightly earlier than the point you chose. A re-encode is frame-accurate.

### Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` `→` or `J` `L` | Back / forward 10 s (`Shift` + arrows = 1 frame) |
| `Home` `End` | Go to start / end |
| `S` | Split at the playhead |
| `Del` / `Shift+Del` | Delete the selected clip, closing / keeping the gap |
| `I` `O` | Trim the selected clip's start / end to the playhead |
| `Ctrl+Z` `Ctrl+Y` | Undo / redo |
| `Ctrl` + mouse wheel | Zoom the timeline |

### On a phone or tablet

Below 860 px wide the editor is a single column that fills the screen: the editor takes the room that is left (preview, playback controls, timeline), and **My media** is a strip of thumbnails pinned to the bottom. Under the playback controls, the time sits on the left and the split, delete and settings buttons on the right.

- Tap **+** on a thumbnail to add it on a new line (there is no hover on touch, so the buttons are always visible).
- Drag a clip to move it, its edges to trim it, and the ruler to move the playhead. Dragging an empty part of the timeline pans it; the zoom buttons zoom it.
- The sliders button next to split and delete opens the clip settings as a sheet at the bottom; the close button hides it again.

## The web version

It runs the same editor with **ffmpeg.wasm** (single-threaded) instead of the native ffmpeg. How it differs from the desktop app:

- **Engine:** the engine downloads on first use (about 10 MB, gzip-compressed; 31 MB once unpacked), and the browser caches it.
- **Speed:** a lossless export is still fast. A forced re-encode runs inside the browser and is much slower than on the desktop, so prefer short clips there.
- **Memory:** the finished file is built in memory before it is saved, so very large exports can fail, and phones have far less memory than a computer. Use the desktop app for long or large videos.
- **Saving:** Chrome and Edge ask where to save; other browsers download the file to the usual folder. "Show in folder" is desktop only.
- **Hosting:** `npm run build:web` writes a static site to `dist-web/`. It needs `http://` or `https://` (not `file://`). The engine's `.wasm` is shipped as `ffmpeg-core.wasm.gz` (the browser unpacks it), so no file is larger than about 10 MiB, well under the 25 MiB per-file limit of hosts such as Cloudflare Pages. The build fails if any file goes over that limit.

### Deploy to Cloudflare Pages

The web build is a static site, so it needs no server code.

**From your computer** (no build runs on Cloudflare):

```
npx wrangler login       # once
npm run deploy:web
```

This builds the site and uploads `dist-web/` to a Pages project named `simple-video-editor` (Wrangler offers to create it the first time). Pages gives it HTTPS, which Chrome and Edge need for the save dialog.

**From Git** (Cloudflare builds on every push): create a Pages project from your repository with these settings.

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `npm run build:web` |
| Build output directory | `dist-web` |
| Environment variable | `ELECTRON_SKIP_BINARY_DOWNLOAD` = `1` (skips Electron's large binary download) |

Keep only one lockfile (`package-lock.json` or `pnpm-lock.yaml`) in the repository so the install step is unambiguous. The `_headers` file written by the build sets caching for the engine files.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the desktop app |
| `npm run start:web` | Build the web version and serve it at http://127.0.0.1:5180/ |
| `npm run build:web` | Build the static web site into `dist-web/` |
| `npm run deploy:web` | Build the web site and upload it to Cloudflare Pages (project `simple-video-editor`) |
| `npm run build:desktop` | Build the Windows installer into `release/` |
| `npm run build:icons` | Rebuild the inline SVG icon sprite in `index.html` from `icons/` |
| `npm run check` | Syntax-check every JavaScript file |
| `npm run clean` | Remove `dist-web/` and `release/` |

### Building the installer

```
npm run build:desktop
```

This writes `Simple-Video-Editor-Setup-<version>.exe` to `release/`. The installer is not code-signed, so Windows SmartScreen may warn on first run ("More info", then "Run anyway").

## Project structure

| File | Role |
|---|---|
| `index.html`, `renderer.js`, `styles.css` | The editor UI, shared by every version |
| `export-plan.js`, `media.js` | Pure logic shared by both backends: probing, clip validation, the lossless-or-re-encode decision, ffmpeg arguments |
| `main.js`, `preload.js`, `exporter.js` | Desktop only: the Electron main process and the native ffmpeg |
| `web-api.js` | Web only: the same `window.api` implemented with ffmpeg.wasm (does nothing inside Electron) |
| `icons/` | [Lucide](https://lucide.dev) SVG sources, inlined into `index.html` as a sprite |
| `scripts/` | Build, serve, check and clean helpers |

## Troubleshooting

- **`npm start` cannot find the Electron binary.** Electron's install script was skipped or failed (some package managers and Node versions do this). Run `node node_modules/electron/install.js`; if `node_modules/electron/dist/electron.exe` is still missing, extract the Electron zip from your cache (`%LOCALAPPDATA%\electron\Cache`) into `node_modules/electron/dist`.
- **A video cannot be previewed.** The preview uses the browser's player, so codecs such as HEVC/H.265 may not play, even though the export can still handle them.
