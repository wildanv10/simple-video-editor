# Video Trimmer

A small desktop video editor (Electron) with a Clipchamp-style layout: **My media** on the left, preview in the middle, a timeline underneath. It opens straight into the editor, so there is no home screen, no project saving and no account.

## Run

```
npm install
npm start
```

ffmpeg is bundled through `ffmpeg-static`, so no separate install is needed.

## Build the installer (Windows)

```
npm run dist
```

The installer is written to the `release` folder.

## How it works

| | |
|---|---|
| Speed | Almost instant: stream copy (`-c copy`) in Auto export |
| Quality | Identical to the source in Auto export |
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
6. **Export** and choose a quality:
   - **Auto**: original quality. Lossless stream copy when nothing needs re-encoding.
   - **1080p** / **720p**: re-encoded to that size (the short side of the first clip on the lowest line).

Export falls back to re-encoding when there is more than one line, when a line has a gap, when a clip has effects, when you pick 1080p/720p, or when the clips do not share the same codec, size and frame rate (stream copy cannot join those). The frame rate follows the source, up to 60 fps. Re-encoding uses H.264 + AAC in an MP4.

Because lossless cuts can only start on a keyframe, a clip may begin slightly earlier than the point you chose. Use 1080p/720p when you need frame-accurate cuts.

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

## Icons

Icons are [Lucide](https://lucide.dev) SVGs kept in `icons/` and inlined into `index.html` as a sprite. After adding or removing an icon, run `node scripts/build-sprite.js`.
