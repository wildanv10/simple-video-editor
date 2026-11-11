// Runs the ffmpeg jobs that turn a timeline into one file, with the native ffmpeg binary.
// The decisions and argument lists live in export-plan.js (shared with the web app).
// No Electron dependency, so it can be exercised directly from Node.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const plan = require('./export-plan');

const { sourceLength, totalLength, byTime } = plan;
const progress = ['-progress', 'pipe:1', '-nostats'];

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

// Lossless: cut each clip by stream copy, then join the pieces with the concat demuxer.
async function exportCopy(ctx) {
  const { outputPath, tmpDir, ctl, onProgress } = ctx;
  const clips = [...ctx.clips].sort(byTime);
  const total = clips.reduce((sum, c) => sum + sourceLength(c), 0);

  if (clips.length === 1) {
    return run(ctx, [...plan.cutArgs(clips[0]), ...progress, outputPath], (t) => onProgress(t / total));
  }

  const ext = path.extname(outputPath);
  const parts = [];
  let done = 0;
  for (const [i, c] of clips.entries()) {
    if (ctl.cancelled) return { code: -1, stderr: '' };
    const part = path.join(tmpDir, `part${i}${ext}`);
    const result = await run(ctx, [...plan.cutArgs(c), ...progress, part], (t) => onProgress(((done + t) / total) * 0.8));
    if (result.code !== 0) return result;
    done += sourceLength(c);
    parts.push(part);
  }

  const list = path.join(tmpDir, 'parts.txt');
  fs.writeFileSync(list, plan.concatListText(parts));
  return run(ctx, [...plan.concatArgs(list), ...progress, outputPath], (t) => onProgress(0.8 + (t / total) * 0.2));
}

async function exportProject(ctx) {
  const { clips, mode, outputPath, onProgress } = ctx;
  const method = plan.planExport(clips, mode);
  const result = method === 'copy'
    ? await exportCopy(ctx)
    : await run(ctx, [...plan.buildReencodeArgs(clips, mode), ...progress, outputPath], (t) => onProgress(t / totalLength(clips)));
  return { ...result, method };
}

module.exports = {
  exportProject,
  planExport: plan.planExport,
  buildReencodeArgs: (clips, mode, outputPath) => [...plan.buildReencodeArgs(clips, mode), ...progress, outputPath],
  outputLength: plan.outputLength,
  totalLength,
  isPlain: plan.isPlain,
};
