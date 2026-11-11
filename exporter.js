// Builds and runs the ffmpeg jobs that turn a timeline into one file.
// No Electron dependency, so it can be exercised directly from Node.
//
// The timeline has several lines (layers). Each clip sits on a layer at a start time;
// a clip on a higher layer covers the ones below it, and all audio is mixed.
//
// Clip shape: { path, layer, start, in, out, speed, volume, fadeIn, fadeOut,
//               hasAudio, width, height, fps, sig }

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const f3 = (n) => n.toFixed(3);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

const isPlain = (c) => c.speed === 1 && c.volume === 1 && !c.fadeIn && !c.fadeOut;
const sourceLength = (c) => c.out - c.in;
const outputLength = (c) => sourceLength(c) / c.speed;
const endOf = (c) => c.start + outputLength(c);
const totalLength = (clips) => Math.max(...clips.map(endOf));
const byTime = (a, b) => a.start - b.start;
const byLayer = (a, b) => a.layer - b.layer || a.start - b.start;

// 'copy' (lossless stream copy) needs: Auto quality, a single line without gaps, no
// effects, and the same codec parameters in every clip. Anything else is re-encoded.
function planExport(clips, mode) {
  if (mode !== 'auto' || !clips.every(isPlain)) return 'reencode';
  if (!clips.every((c) => c.layer === clips[0].layer && c.sig === clips[0].sig)) return 'reencode';
  const ordered = [...clips].sort(byTime);
  const seamless = ordered.every((c, i) => Math.abs(c.start - (i ? endOf(ordered[i - 1]) : 0)) < 0.02);
  return seamless ? 'copy' : 'reencode';
}

function run(ctx, args, onTime) {
  return new Promise((resolve) => {
    const proc = spawn(ctx.ffmpegPath, args, { windowsHide: true });
    ctx.ctl.proc = proc;
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      const m = [...chunk.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (m && onTime) onTime(Number(m[1]) / 1e6);
    });
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    proc.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    proc.on('close', (code) => {
      ctx.ctl.proc = null;
      resolve({ code, stderr });
    });
  });
}

const base = ['-hide_banner', '-nostdin', '-y'];
const progress = ['-progress', 'pipe:1', '-nostats'];

function cutArgs(c, out) {
  return [
    ...base, '-ss', f3(c.in), '-i', c.path, '-t', f3(sourceLength(c)),
    '-sn', '-dn', '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...progress, out,
  ];
}

// Lossless: cut each clip by stream copy, then join the pieces with the concat demuxer.
async function exportCopy(ctx) {
  const { outputPath, tmpDir, ctl, onProgress } = ctx;
  const clips = [...ctx.clips].sort(byTime);
  const total = clips.reduce((sum, c) => sum + sourceLength(c), 0);

  if (clips.length === 1) {
    return run(ctx, cutArgs(clips[0], outputPath), (t) => onProgress(t / total));
  }

  const ext = path.extname(outputPath);
  const parts = [];
  let done = 0;
  for (const [i, c] of clips.entries()) {
    if (ctl.cancelled) return { code: -1, stderr: '' };
    const part = path.join(tmpDir, `part${i}${ext}`);
    const result = await run(ctx, cutArgs(c, part), (t) => onProgress(((done + t) / total) * 0.8));
    if (result.code !== 0) return result;
    done += sourceLength(c);
    parts.push(part);
  }

  const list = path.join(tmpDir, 'parts.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  return run(
    ctx,
    [...base, '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...progress, outputPath],
    (t) => onProgress(0.8 + (t / total) * 0.2),
  );
}

// Re-encode: every clip gets its effects and is fitted to one canvas, then the clips are
// laid over a black base from the lowest layer to the highest. Gaps stay black/silent.
// mode: 'auto' (size of the first clip on the lowest line), '1080' or '720' (short side).
function buildReencodeArgs(clips, mode, outputPath) {
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
  const anyAudio = clips.some((c) => c.hasAudio);
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

    if (anyAudio && c.hasAudio) {
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
  args.push('-movflags', '+faststart', ...progress, outputPath);
  return args;
}

async function exportProject(ctx) {
  const { clips, mode, outputPath, onProgress } = ctx;
  const method = planExport(clips, mode);
  const result = method === 'copy'
    ? await exportCopy(ctx)
    : await run(ctx, buildReencodeArgs(clips, mode, outputPath), (t) => onProgress(t / totalLength(clips)));
  return { ...result, method };
}

module.exports = { exportProject, planExport, buildReencodeArgs, outputLength, totalLength, isPlain };
