const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const { parseProbe } = require('./media');
const { exportProject } = require('./exporter');
const { normalizeClips, planExport } = require('./export-plan');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'mpg', 'mpeg'];

// Containers Chromium can play natively. Anything else (e.g. MPEG-TS from an
// HLS download renamed to .mp4) is remuxed to a temporary MP4 first.
const NATIVE_FORMATS = /mp4|matroska|webm|ogg/;

let win = null;
let job = null; // running export: { cancelled, proc }
let nextId = 1;
const library = new Map(); // media id -> info (the renderer only ever refers to ids)

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#f4f4f8',
    title: 'Simple Video Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

// Run ffmpeg to completion; resolve with its exit code and stderr.
function runFfmpeg(args) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-20000); });
    proc.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    proc.on('close', (code) => resolve({ code, stderr }));
  });
}


function tail(text, lines) {
  return text.trim().split('\n').slice(-lines).join('\n');
}

async function makeThumbnail(file, duration) {
  const out = path.join(app.getPath('temp'), `simple-video-editor-thumb-${Date.now()}.jpg`);
  const at = Math.min(1, duration / 3) || 0;
  const result = await runFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-ss', at.toFixed(3), '-i', file,
    '-frames:v', '1', '-vf', 'scale=-2:180', '-an', '-sn', '-q:v', '4', out,
  ]);
  try {
    if (result.code !== 0) return null;
    return `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}`;
  } catch {
    return null;
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}

// Probe a file and make sure it is playable; register it in the library.
async function prepare(file) {
  const probe = parseProbe((await runFfmpeg(['-hide_banner', '-i', file])).stderr);
  if (!probe) return { error: 'This file is not a recognized video.' };
  if (!probe.hasVideo) return { error: 'This file has no video stream.' };

  let working = file;
  let temp = false;
  if (!NATIVE_FORMATS.test(probe.format)) {
    working = path.join(app.getPath('temp'), `simple-video-editor-${Date.now()}-${nextId}.mp4`);
    const remux = await runFfmpeg([
      '-hide_banner', '-nostdin', '-y', '-i', file,
      '-map', '0:v:0', '-map', '0:a?', '-sn', '-dn',
      '-c', 'copy', '-movflags', '+faststart', working,
    ]);
    if (remux.code !== 0) {
      fs.rm(working, { force: true }, () => {});
      return { error: `Failed to prepare the video:\n${tail(remux.stderr, 3)}` };
    }
    temp = true;
  }

  const id = nextId++;
  const { duration, width, height, fps, hasAudio, sig } = probe;
  library.set(id, { id, original: file, path: working, temp, duration, width, height, fps, hasAudio, sig });
  return {
    id,
    name: path.basename(file),
    url: pathToFileURL(working).href,
    converted: temp,
    duration,
    width,
    height,
    fps,
    hasAudio,
    thumb: await makeThumbnail(working, duration),
  };
}

function release(id) {
  const media = library.get(id);
  if (!media) return;
  if (media.temp) fs.rm(media.path, { force: true }, () => {});
  library.delete(id);
}

ipcMain.handle('pick-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video', extensions: VIDEO_EXTS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return canceled ? [] : filePaths;
});

ipcMain.handle('prepare', (_e, file) => prepare(file));
ipcMain.handle('release', (_e, id) => release(id));
ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));

ipcMain.handle('cancel', () => {
  if (job) {
    job.cancelled = true;
    job.proc?.kill();
  }
});

ipcMain.handle('export', async (e, { clips }) => {
  if (job) return { error: 'Another export is still running.' };
  if (!Array.isArray(clips) || clips.length === 0) return { error: 'The timeline is empty.' };

  let resolved;
  try {
    // Validate the UI's input and attach the library data (paths, stream info) to each clip.
    resolved = normalizeClips(clips, (id) => library.get(id));
  } catch (err) {
    return { error: err.message };
  }

  // Stream copy keeps the source container; re-encoding always writes MP4.
  // The first clip on the lowest line names the file (and sets the canvas size).
  const lead = [...resolved].sort((a, b) => a.layer - b.layer || a.start - b.start)[0];
  const firstMedia = library.get(lead.mediaId);
  const plan = planExport(resolved); // { method: 'copy' | 'reencode', why }
  const ext = plan.method === 'copy' ? path.extname(firstMedia.path) : '.mp4';
  const base = path.basename(firstMedia.original, path.extname(firstMedia.original));

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export video',
    defaultPath: path.join(path.dirname(firstMedia.original), `${base}_trim${ext}`),
    filters: [{ name: 'Video', extensions: [ext.slice(1)] }],
  });
  if (canceled || !filePath) return { canceled: true };

  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if ([...library.values()].some((m) => same(filePath, m.original) || same(filePath, m.path))) {
    return { error: 'The output file must not be one of the source files.' };
  }

  const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'simple-video-editor-export-'));
  const ctl = { cancelled: false, proc: null };
  job = ctl;
  const send = (fraction, info) => {
    if (!e.sender.isDestroyed()) e.sender.send('export-progress', Math.min(1, Math.max(0, fraction)), info);
  };
  try {
    send(0, plan); // tells the UI right away whether this will be lossless or a re-encode
    const result = await exportProject({
      ffmpegPath,
      clips: resolved,
      outputPath: filePath,
      tmpDir,
      ctl,
      onProgress: send,
    });
    if (ctl.cancelled) {
      fs.rm(filePath, { force: true }, () => {});
      return { canceled: true };
    }
    if (result.code === 0) return { ok: true, output: filePath, method: result.method, why: result.why };
    fs.rm(filePath, { force: true }, () => {});
    return { error: tail(result.stderr, 4) || `ffmpeg exited with code ${result.code}` };
  } finally {
    job = null;
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  job?.proc?.kill();
  for (const media of library.values()) {
    if (media.temp) fs.rmSync(media.path, { force: true });
  }
});

app.on('window-all-closed', () => app.quit());
