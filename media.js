// Parses the stderr of `ffmpeg -i <file>` into a small description of the media.
// (ffmpeg-static ships no ffprobe, and ffmpeg.wasm only has the banner, so both the
// desktop app and the web app read the human-readable output.)
//
// Plain script usable from Node (require) and from the browser (window.VTMedia).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VTMedia = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  function parseProbe(stderr) {
    const format = /Input #0, (.+?), from/.exec(stderr)?.[1];
    if (!format) return null;

    const lines = stderr.split(/\r?\n/);
    const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;

    const videoIdx = lines.findIndex((l) => /Stream #\d+:\d+.*: Video:/.test(l) && !/attached pic/.test(l));
    const audioLine = lines.find((l) => /Stream #\d+:\d+.*: Audio:/.test(l));
    const info = { format, duration, hasVideo: videoIdx >= 0, hasAudio: Boolean(audioLine) };
    if (!info.hasVideo) return info;

    const videoLine = lines[videoIdx];
    let [, width, height] = /(\d{2,5})x(\d{2,5})/.exec(videoLine) || [];
    width = Number(width) || 0;
    height = Number(height) || 0;

    // Phone videos carry a rotation in side data; ffmpeg applies it when decoding.
    let rotation = 0;
    for (let i = videoIdx + 1; i < lines.length && !/Stream #/.test(lines[i]); i++) {
      const m = /rotation of (-?[\d.]+) degrees/.exec(lines[i]);
      if (m) rotation = Math.round(Number(m[1]));
    }
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];

    const fps = Number(/([\d.]+) fps/.exec(videoLine)?.[1] ?? /([\d.]+) tbr/.exec(videoLine)?.[1]) || 30;
    const vcodec = /Video: (\w+)/.exec(videoLine)?.[1] || '';
    const pixFmt = /Video: [^,]+, ([a-z0-9]+)/.exec(videoLine)?.[1] || '';

    let audioSig = 'none';
    if (audioLine) {
      const acodec = /Audio: (\w+)/.exec(audioLine)?.[1] || '';
      const rate = /(\d+) Hz/.exec(audioLine)?.[1] || '';
      const layout = /\d+ Hz, ([^,]+)/.exec(audioLine)?.[1] || '';
      audioSig = [acodec, rate, layout].join(':');
    }

    // Clips can be joined without re-encoding only if every stream parameter matches.
    const sig = [vcodec, width, height, fps, pixFmt, audioSig].join('|');
    return { ...info, width, height, fps, sig };
  }

  return { parseProbe };
});
