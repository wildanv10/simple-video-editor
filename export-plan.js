// Pure export logic shared by the desktop app (Node, native ffmpeg) and the web app
// (ffmpeg.wasm): validation of clips, the lossless-or-re-encode decision, and the ffmpeg
// argument lists. Nothing here runs ffmpeg or touches files; callers add the output path
// (and, on the desktop, the progress flags) after the returned arguments.
//
// The timeline has several lines (layers). Each clip sits on a layer at a start time;
// a clip on a higher layer covers the ones below it, and all audio is mixed.
//
// Clip shape: { path, layer, start, in, out, speed, volume, fadeIn, fadeOut,
//               hasAudio, width, height, fps, sig }
//
// Plain script usable from Node (require) and from the browser (window.VTPlan).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VTPlan = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const f3 = (n) => n.toFixed(3);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  const isPlain = (c) => c.speed === 1 && c.volume === 1 && !c.fadeIn && !c.fadeOut;
  const sourceLength = (c) => c.out - c.in;
  const outputLength = (c) => sourceLength(c) / c.speed;
  const endOf = (c) => c.start + outputLength(c);
  const totalLength = (clips) => Math.max(...clips.map(endOf));
  const byTime = (a, b) => a.start - b.start;
  const byLayer = (a, b) => a.layer - b.layer || a.start - b.start;

  // Validate what the UI sent and attach the library data (path, stream info) to each clip.
  // `lookup(mediaId)` returns { path, duration, hasAudio, width, height, fps, sig } or nothing.
  function normalizeClips(clips, lookup) {
    const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    return clips.map((c) => {
      const media = lookup(c.mediaId);
      if (!media) throw new Error('A clip refers to media that is no longer loaded.');
      const limit = media.duration || Infinity;
      const start = clamp(num(c.in, 0), 0, limit);
      const end = clamp(num(c.out, 0), 0, limit);
      if (end - start < 0.05) throw new Error('A clip is too short to export.');
      return {
        mediaId: c.mediaId,
        path: media.path,
        layer: Math.max(0, Math.round(num(c.layer, 0))),
        start: Math.max(0, num(c.start, 0)),
        in: start,
        out: end,
        speed: clamp(num(c.speed, 1), 0.5, 2),
        volume: clamp(num(c.volume, 1), 0, 1),
        fadeIn: clamp(num(c.fadeIn, 0), 0, 60),
        fadeOut: clamp(num(c.fadeOut, 0), 0, 60),
        hasAudio: media.hasAudio,
        width: media.width,
        height: media.height,
        fps: media.fps,
        sig: media.sig,
      };
    });
  }

  // 'copy' (lossless stream copy) needs: Auto quality, a single line without gaps, no
  // effects, and the same codec parameters in every clip. Anything else is re-encoded.
  function planExport(clips, mode) {
    if (mode !== 'auto' || !clips.every(isPlain)) return 'reencode';
    if (!clips.every((c) => c.layer === clips[0].layer && c.sig === clips[0].sig)) return 'reencode';
    const ordered = [...clips].sort(byTime);
    const seamless = ordered.every((c, i) => Math.abs(c.start - (i ? endOf(ordered[i - 1]) : 0)) < 0.02);
    return seamless ? 'copy' : 'reencode';
  }

  const base = ['-hide_banner', '-nostdin', '-y'];

  // Stream-copy one clip. The output path goes after these arguments.
  function cutArgs(c) {
    return [
      ...base, '-ss', f3(c.in), '-i', c.path, '-t', f3(sourceLength(c)),
      '-sn', '-dn', '-c', 'copy', '-avoid_negative_ts', 'make_zero',
    ];
  }

  // Join already-cut pieces with the concat demuxer. The output path goes after these.
  const concatArgs = (listPath) => [
    ...base, '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero',
  ];

  const concatListText = (parts) => parts
    .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');

  // Re-encode: every clip gets its effects and is fitted to one canvas, then the clips are
  // laid over a black base from the lowest layer to the highest. Gaps stay black/silent.
  // mode: 'auto' (size of the first clip on the lowest line), '1080' or '720' (short side).
  // The output path goes after these arguments.
  function buildReencodeArgs(clips, mode) {
    const ordered = [...clips].sort(byLayer);
    const first = ordered[0];
    let width = even(first.width || 1920);
    let height = even(first.height || 1080);
    if (mode !== 'auto' && first.width && first.height) {
      const scale = Number(mode) / Math.min(first.width, first.height);
      width = even(first.width * scale);
      height = even(first.height * scale);
    }
    // Keep the highest source frame rate, up to 60 fps; never invent frames above it.
    const fps = Math.min(60, Math.max(...clips.map((c) => c.fps || 30)));
    const total = totalLength(clips);
    const stereo = 'aformat=sample_fmts=fltp:channel_layouts=stereo';

    const args = [...base];
    const filters = [`color=c=black:s=${width}x${height}:r=${fps}:d=${f3(total)},format=yuv420p[base]`];
    const audio = [];
    let current = 'base';

    ordered.forEach((c, i) => {
      const length = outputLength(c);
      const fadeIn = Math.min(c.fadeIn, length);
      const fadeOut = Math.min(c.fadeOut, length - fadeIn);
      args.push('-ss', f3(c.in), '-t', f3(sourceLength(c)), '-i', c.path);

      // Fades are alpha fades, so a faded clip reveals the layer below it.
      let video = `[${i}:v:0]setpts=(PTS-STARTPTS)/${c.speed},fps=${fps},`
        + `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
        + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuva420p`;
      if (fadeIn > 0) video += `,fade=t=in:st=0:d=${f3(fadeIn)}:alpha=1`;
      if (fadeOut > 0) video += `,fade=t=out:st=${f3(length - fadeOut)}:d=${f3(fadeOut)}:alpha=1`;
      video += `,setpts=PTS+${f3(c.start)}/TB`;
      filters.push(`${video}[v${i}]`);
      filters.push(`[${current}][v${i}]overlay=eof_action=pass:enable='between(t,${f3(c.start)},${f3(endOf(c))})'[o${i}]`);
      current = `o${i}`;

      if (c.hasAudio) {
        let sound = `[${i}:a:0]asetpts=PTS-STARTPTS,aresample=44100,${stereo}`;
        if (c.speed !== 1) sound += `,atempo=${c.speed}`;
        if (c.volume !== 1) sound += `,volume=${c.volume}`;
        if (fadeIn > 0) sound += `,afade=t=in:st=0:d=${f3(fadeIn)}`;
        if (fadeOut > 0) sound += `,afade=t=out:st=${f3(length - fadeOut)}:d=${f3(fadeOut)}`;
        const ms = Math.round(c.start * 1000);
        filters.push(`${sound},adelay=${ms}|${ms}[a${i}]`);
        audio.push(`[a${i}]`);
      }
    });

    filters.push(`[${current}]format=yuv420p[outv]`);
    if (audio.length) {
      // A silent base the length of the timeline keeps the mix from ending early.
      filters.push(`anullsrc=r=44100:cl=stereo:d=${f3(total)},${stereo}[abase]`);
      filters.push(`[abase]${audio.join('')}amix=inputs=${audio.length + 1}:duration=first:normalize=0[outa]`);
    }

    args.push('-filter_complex', filters.join(';'), '-map', '[outv]');
    if (audio.length) args.push('-map', '[outa]');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
    if (audio.length) args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-movflags', '+faststart');
    return args;
  }

  return {
    normalizeClips, planExport, cutArgs, concatArgs, concatListText, buildReencodeArgs,
    isPlain, sourceLength, outputLength, endOf, totalLength, byTime, byLayer,
  };
});
