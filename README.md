# Video Trimmer

A simple desktop app (Electron) for trimming videos: preview, slider, and save.

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

## Usage

1. Click **Open Video** or drag a video file into the window.
2. Drag the slider handles (or play the video and press **I** / **O**) to set the start and end points. You can also type the times.
3. Click **Save Clip** and choose where to save the file.

Files whose container Chromium cannot play (for example MPEG-TS from an HLS/.m3u8 download renamed to `.mp4`, or AVI/FLV) are automatically remuxed to a temporary MP4 for preview, and the trimmed clip is saved as a regular MP4. This only changes the wrapper; nothing is re-encoded.

Export does not re-encode (`-c copy`): it is almost instant and lossless, but cuts snap to the nearest keyframe, so the start of the clip can shift slightly.

Shortcuts: `Space` play/pause, `I` set start, `O` set end, `←/→` or `J`/`L` back/forward 10 s (`Shift` + `←/→` = 1 frame).

Note: preview uses the Chromium player, so codecs such as HEVC/H.265 may not be previewable.
