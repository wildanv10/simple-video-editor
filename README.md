# Video Trimmer

A small video editor with a Clipchamp-style layout: **My media** on the left, preview in the middle, a timeline underneath. It opens straight into the editor, so there is no home screen, no project saving and no account.

It runs two ways from the same code: as a **desktop app** (Electron, native ffmpeg) and as a **web app** (any modern browser, ffmpeg.wasm). Nothing is ever uploaded: in both cases your videos are processed on your own computer.

## Run the desktop app

```
npm install
npm start
```

ffmpeg is bundled through `ffmpeg-static`, so no separate install is needed.

## Run it on the web

```
npm install
npm run web
```

Then open <http://127.0.0.1:5180/>. `npm run build:web` only builds the static site into `dist-web/`, which you can host on any static web server (it needs `http://` or `https://`, not `file://`).

How the web version differs from the desktop app:

- **Engine:** ffmpeg.wasm (single-threaded). The ~31 MB engine downloads on first use and the browser caches it.
- **Speed:** lossless export (stream copy) is still fast. A forced re-encode (effects, overlapping clips, gaps, or different formats) runs inside the browser and is much slower than on the desktop, so prefer short clips there.
- **Memory:** the finished file is built in memory before it is saved, so very large exports can fail. Use the desktop app for long or large videos.
- **Saving:** Chrome and Edge ask where to save; other browsers download the file to the usual Downloads folder. "Show in folder" exists only on the desktop.
- **Files:** pick files with **Import media** or drag them into the page. Cancelling an export restarts the engine, which takes a moment.

### On a phone or tablet

Below 860 px wide the editor becomes a single column that fills the screen: the editor takes all the room that is left (preview, playback controls, the timeline), and **My media** is a strip of thumbnails pinned to the bottom. Under the playback controls, the time sits on the left and the split, delete and settings buttons on the right. Touch works like this:

- Tap **+** on a thumbnail to add it on a new line (there is no hover on touch, so the buttons are always visible). Dragging a thumbnail also works where the browser supports it.
- Drag a clip to move it, drag its edges to trim it, and drag the ruler to move the playhead. Dragging an empty part of the timeline pans it; the zoom buttons zoom it.
- Tap the sliders button next to split and delete to open the clip settings (trim, fade, speed, volume) as a sheet at the bottom; the close button hides it again.

Phones have far less memory than a computer, so keep to short clips there.

## Build the installer (Windows)

```
npm run dist
```

The installer is written to the `release` folder.

## How it works

| | |
|---|---|
| Speed | Almost instant: clips are joined by stream copy (`-c copy`) whenever possible |
| Quality | Identical to the source when joined by stream copy |
| Account | Not needed |
| TS / HLS | Remuxed automatically (e.g. MPEG-TS from an `.m3u8` download renamed to `.mp4`) |
| Cut precision | Limited to keyframes in lossless export |
| Join clips, layers, effects | Yes (several lines; fade in/out, speed, volume/mute) |
| Text | No |

1. **Import media** (or drag files into the window). The first import is added to the timeline automatically.
2. The timeline has several **lines** (layers). A clip on a higher line covers the lines below it while it plays, and all audio is mixed. Empty lines disappear on their own.
   - The **+** button on a media thumbnail (or a double-click) adds the clip on a **new line** on top, starting at the playhead.
   - **Drag** a thumbnail (or a clip from another line) and drop it where you want it:
     - **Inside a line** (the middle of the lane): it continues that line, snapping to the end of the previous clip, the playhead, or other clips. If the spot is taken it goes to the nearest free slot.
     - **Above or below a line** (the top or bottom edge of a lane, or the gap between two lanes): a purple bar shows where a **new line** opens, right above or below that line.
     - **On the dashed strips** at the very top or bottom: a new line on top of, or underneath, everything.
3. **Trim** by dragging a clip's left or right edge, or type exact times in the Clip panel. Trimming does not move the other clips. **Split** (`S`) at the playhead, and drag a clip sideways to move it in time, or up and down to another line.
4. **Delete** (`Del`) removes the selected clip and closes the gap on its line; `Shift+Del` leaves the gap (it renders as black, silent video).
5. Select a clip to open the **Clip** panel: trim times, fade in/out, speed (0.5x to 2x), and volume. A fade reveals the lines below.
6. **Export.** There are no options: the app picks the fastest way that gives the result you built.

### Fast (lossless) or slow (re-encode)

The clips are joined **without re-encoding** (a fraction of a second, no quality loss) when none of these apply:

| Re-encoding is only used when | What to do to keep it lossless |
|---|---|
| a clip has an **effect** (fade, speed, volume) | leave the effects off |
| clips **overlap in time** on different lines | put them one after another; which line a clip is on does not matter |
| there is a **gap** between clips | close the gap (`Del` closes it for you) |
| clips use **different formats** (codec, profile, size, frame rate rounded to a whole number, audio) | use clips from the same source or with the same settings |

While exporting, the app says which method it is using and, for a re-encode, exactly why. Re-encoding keeps the size of the first clip on the lowest line, the highest source frame rate (up to 60 fps), and writes H.264 + AAC in an MP4. It is far slower than joining: on a 6-core desktop, 1080p re-encodes at roughly 5 to 6 times real time, against about 200 times for a lossless join.

Because lossless cuts can only start on a keyframe, a clip may begin slightly earlier than the point you chose (a re-encode is frame-accurate).

## Shortcuts

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

Note: the preview uses the Chromium player, so codecs such as HEVC/H.265 may not be previewable.

## How the code is organised

| File | Role |
|---|---|
| `renderer.js`, `index.html`, `styles.css` | The editor UI, shared by both versions |
| `export-plan.js`, `media.js` | Pure logic shared by both versions: probing, validation, lossless-or-re-encode decision, ffmpeg arguments |
| `main.js`, `preload.js`, `exporter.js` | Desktop only: Electron main process and native ffmpeg |
| `web-api.js` | Web only: the same `window.api` implemented with ffmpeg.wasm (does nothing inside Electron) |
| `scripts/build-web.js`, `scripts/serve.js` | Build and locally serve the web version |

## Icons

Icons are [Lucide](https://lucide.dev) SVGs kept in `icons/` and inlined into `index.html` as a sprite. After adding or removing an icon, run `node scripts/build-sprite.js`.
