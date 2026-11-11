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
  const TOLERANCE = 0.02; // seconds: smaller gaps or overlaps between clips are ignored

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

  // What is on the timeline that cannot be done by copying streams.
  function analyze(clips) {
    const ordered = [...clips].sort(byTime);
    let overlap = false;
    let gap = ordered[0].start > TOLERANCE;
    let reach = 0; // how far the clips so far extend
    for (const c of ordered) {
      const delta = c.start - reach;
      if (delta < -TOLERANCE) overlap = true;
      else if (delta > TOLERANCE && reach > 0) gap = true;
      reach = Math.max(reach, endOf(c));
    }
    return {
      effects: !clips.every(isPlain),
      overlap,
      gap,
      formats: !clips.every((c) => c.sig === clips[0].sig),
    };
  }

  // The lossless method (stream copy) joins clips one after another, so it works when
  // nothing needs re-encoding: no effects, no gaps, no clips on top of each other, and
  // compatible streams. Which line a clip is on does not matter. Anything else is
  // re-encoded; `why` says what forced it.
  function planExport(clips) {
    const found = analyze(clips);
    const reasons = [];
    if (found.effects) reasons.push('clips have effects (fade, speed or volume)');
    if (found.overlap) reasons.push('clips overlap in time on different lines');
    if (found.gap) reasons.push('there is a gap between clips');
    if (found.formats) reasons.push('clips use different formats');
    return reasons.length
      ? { method: 'reencode', why: reasons.join(', ') }
      : { method: 'copy', why: null };
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

  const DEFAULT_VIDEO_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];
  const STEREO = 'aformat=sample_fmts=fltp:channel_layouts=stereo';

  // Re-encode. The canvas is the size of the first clip on the lowest line, the frame rate
  // is the highest source rate up to 60 fps (frames are never invented above it).
  // options.videoArgs picks the encoder (default: x264). The output path goes after these.
  function buildReencodeArgs(clips, { videoArgs = DEFAULT_VIDEO_ARGS } = {}) {
    const first = [...clips].sort(byLayer)[0];
    const canvas = {
      width: even(first.width || 1920),
      height: even(first.height || 1080),
      fps: Math.min(60, Math.max(...clips.map((c) => c.fps || 30))),
      total: totalLength(clips),
      anyAudio: clips.some((c) => c.hasAudio),
    };
    const graph = analyze(clips).overlap ? overlayGraph(clips, canvas) : sequenceGraph(clips, canvas);

    const args = [...base, ...graph.inputs, '-filter_complex', graph.filters.join(';'), '-map', '[outv]'];
    if (graph.audio) args.push('-map', '[outa]');
    args.push(...videoArgs, '-pix_fmt', 'yuv420p');
    if (graph.audio) args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-movflags', '+faststart');
    return args;
  }

  // Fit a clip to the canvas: speed, frame rate, size (letterboxed), and optional alpha.
  function videoChain(index, c, { width, height, fps }, alpha) {
    return `[${index}:v:0]setpts=(PTS-STARTPTS)/${c.speed},fps=${fps},`
      + `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=${alpha ? 'yuva420p' : 'yuv420p'}`;
  }

  function fades(c) {
    const length = outputLength(c);
    const fadeIn = Math.min(c.fadeIn, length);
    const fadeOut = Math.min(c.fadeOut, length - fadeIn);
    return { length, fadeIn, fadeOut };
  }

  function audioChain(index, c) {
    const { length, fadeIn, fadeOut } = fades(c);
    let sound = `[${index}:a:0]asetpts=PTS-STARTPTS,aresample=44100,${STEREO}`;
    if (c.speed !== 1) sound += `,atempo=${c.speed}`;
    if (c.volume !== 1) sound += `,volume=${c.volume}`;
    if (fadeIn > 0) sound += `,afade=t=in:st=0:d=${f3(fadeIn)}`;
    if (fadeOut > 0) sound += `,afade=t=out:st=${f3(length - fadeOut)}:d=${f3(fadeOut)}`;
    return sound;
  }

  // Clips one after another (gaps become black, silent segments), joined by the concat
  // filter. Much lighter than overlaying: no alpha, no blending.
  function sequenceGraph(clips, canvas) {
    const ordered = [...clips].sort(byTime);
    const inputs = [];
    const filters = [];
    const labels = [];
    let time = 0;
    let input = 0;

    const gap = (length, k) => {
      filters.push(`color=c=black:s=${canvas.width}x${canvas.height}:r=${canvas.fps}:d=${f3(length)},format=yuv420p,setsar=1[v${k}]`);
      if (canvas.anyAudio) filters.push(`anullsrc=r=44100:cl=stereo:d=${f3(length)},${STEREO}[a${k}]`);
    };

    let k = 0;
    for (const c of ordered) {
      if (c.start - time > TOLERANCE) {
        gap(c.start - time, k);
        labels.push(`[v${k}]${canvas.anyAudio ? `[a${k}]` : ''}`);
        k += 1;
      }
      const { length, fadeIn, fadeOut } = fades(c);
      inputs.push('-ss', f3(c.in), '-t', f3(sourceLength(c)), '-i', c.path);
      let video = videoChain(input, c, canvas, false);
      if (fadeIn > 0) video += `,fade=t=in:st=0:d=${f3(fadeIn)}`;
      if (fadeOut > 0) video += `,fade=t=out:st=${f3(length - fadeOut)}:d=${f3(fadeOut)}`;
      filters.push(`${video}[v${k}]`);
      if (canvas.anyAudio) {
        if (c.hasAudio) filters.push(`${audioChain(input, c)}[a${k}]`);
        else filters.push(`anullsrc=r=44100:cl=stereo:d=${f3(length)},${STEREO}[a${k}]`); // keeps the sound in sync
      }
      labels.push(`[v${k}]${canvas.anyAudio ? `[a${k}]` : ''}`);
      input += 1;
      k += 1;
      time = Math.max(time, endOf(c));
    }

    filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=${canvas.anyAudio ? 1 : 0}[outv]${canvas.anyAudio ? '[outa]' : ''}`);
    return { inputs, filters, audio: canvas.anyAudio };
  }

  // Clips that overlap in time: laid over a black base from the lowest layer to the
  // highest, audio mixed. Fades are alpha fades, so a faded clip reveals the layer below.
  function overlayGraph(clips, canvas) {
    const ordered = [...clips].sort(byLayer);
    const inputs = [];
    const filters = [`color=c=black:s=${canvas.width}x${canvas.height}:r=${canvas.fps}:d=${f3(canvas.total)},format=yuv420p[base]`];
    const audio = [];
    let current = 'base';

    ordered.forEach((c, i) => {
      const { length, fadeIn, fadeOut } = fades(c);
      inputs.push('-ss', f3(c.in), '-t', f3(sourceLength(c)), '-i', c.path);
      let video = videoChain(i, c, canvas, true);
      if (fadeIn > 0) video += `,fade=t=in:st=0:d=${f3(fadeIn)}:alpha=1`;
      if (fadeOut > 0) video += `,fade=t=out:st=${f3(length - fadeOut)}:d=${f3(fadeOut)}:alpha=1`;
      video += `,setpts=PTS+${f3(c.start)}/TB`;
      filters.push(`${video}[v${i}]`);
      filters.push(`[${current}][v${i}]overlay=eof_action=pass:enable='between(t,${f3(c.start)},${f3(endOf(c))})'[o${i}]`);
      current = `o${i}`;

      if (c.hasAudio) {
        const ms = Math.round(c.start * 1000);
        filters.push(`${audioChain(i, c)},adelay=${ms}|${ms}[a${i}]`);
        audio.push(`[a${i}]`);
      }
    });

    filters.push(`[${current}]format=yuv420p[outv]`);
    if (audio.length) {
      // A silent base the length of the timeline keeps the mix from ending early.
      filters.push(`anullsrc=r=44100:cl=stereo:d=${f3(canvas.total)},${STEREO}[abase]`);
      filters.push(`[abase]${audio.join('')}amix=inputs=${audio.length + 1}:duration=first:normalize=0[outa]`);
    }
    return { inputs, filters, audio: audio.length > 0 };
  }

  return {
    normalizeClips, analyze, planExport, cutArgs, concatArgs, concatListText, buildReencodeArgs,
    DEFAULT_VIDEO_ARGS, isPlain, sourceLength, outputLength, endOf, totalLength, byTime, byLayer,
  };
});
