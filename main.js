const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'mpg', 'mpeg'];

let win = null;
let job = null;

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: '#14161a',
    title: 'Video Trimmer',
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

// Containers Chromium can play natively. Anything else (e.g. MPEG-TS from an
// HLS download renamed to .mp4) is remuxed to a temporary MP4 first.
const NATIVE_FORMATS = /mp4|matroska|webm|ogg/;

let tempFile = null; // temporary MP4 used for preview
const originals = new Map(); // working file -> original file picked by the user

function removeTemp() {
  if (tempFile) {
    originals.delete(tempFile);
    fs.unlink(tempFile, () => {});
    tempFile = null;
  }
}

async function prepare(file) {
  removeTemp();
  const probe = await runFfmpeg(['-hide_banner', '-i', file]);
  const format = /Input #0, (.+?), from/.exec(probe.stderr)?.[1] || '';
  if (!format) return { error: 'This file is not a recognized video.' };

  let working = file;
  const converted = !NATIVE_FORMATS.test(format);
  if (converted) {
    const tmp = path.join(app.getPath('temp'), `video-trimmer-${Date.now()}.mp4`);
    const remux = await runFfmpeg([
      '-hide_banner', '-nostdin', '-y', '-i', file,
      '-map', '0:v:0', '-map', '0:a?', '-sn', '-dn',
      '-c', 'copy', '-movflags', '+faststart', tmp,
    ]);
    if (remux.code !== 0) {
      fs.unlink(tmp, () => {});
      return { error: `Failed to prepare the video:\n${remux.stderr.trim().split('\n').slice(-3).join('\n')}` };
    }
    tempFile = tmp;
    working = tmp;
    originals.set(tmp, file);
  }
  return { path: working, name: path.basename(file), url: pathToFileURL(working).href, converted };
}

ipcMain.handle('pick-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Select a video',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: VIDEO_EXTS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('prepare', (_e, file) => prepare(file));

ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));

ipcMain.handle('cancel', () => {
  if (job) {
    job.cancelled = true;
    job.proc.kill();
  }
});

ipcMain.handle('trim', async (e, { input, start, end }) => {
  if (job) return { error: 'Another operation is still running.' };
  if (!(end > start) || start < 0) return { error: 'Invalid time range.' };

  // Default name and folder follow the original file; the extension follows the
  // working file (.mp4 if the original had to be converted).
  const original = originals.get(input) || input;
  const ext = path.extname(input);
  const base = path.basename(original, path.extname(original));

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save trimmed video',
    defaultPath: path.join(path.dirname(original), `${base}_trim${ext}`),
    filters: [{ name: 'Video', extensions: [ext.slice(1)] }],
  });
  if (canceled || !filePath) return { canceled: true };
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (same(filePath, input) || same(filePath, original)) {
    return { error: 'The output file must not be the same as the original file.' };
  }

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-ss', start.toFixed(3), '-i', input, '-t', (end - start).toFixed(3),
    '-sn', '-dn', '-c', 'copy', '-avoid_negative_ts', 'make_zero',
    '-progress', 'pipe:1', '-nostats', filePath,
  ];

  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    job = { proc, cancelled: false };
    let errTail = '';

    proc.stdout.on('data', (chunk) => {
      const m = [...chunk.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (m && !e.sender.isDestroyed()) e.sender.send('trim-progress', Number(m[1]) / 1e6);
    });
    proc.stderr.on('data', (chunk) => {
      errTail = (errTail + chunk.toString()).slice(-1500);
    });
    proc.on('error', (err) => {
      job = null;
      resolve({ error: `Failed to run ffmpeg: ${err.message}` });
    });
    proc.on('close', (code) => {
      const cancelled = job && job.cancelled;
      job = null;
      if (cancelled) {
        fs.unlink(filePath, () => {});
        resolve({ canceled: true });
      } else if (code === 0) {
        resolve({ ok: true, output: filePath });
      } else {
        resolve({ error: errTail.trim().split('\n').slice(-4).join('\n') || `ffmpeg exited with code ${code}` });
      }
    });
  });
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  if (job) job.proc.kill();
  if (tempFile) fs.rmSync(tempFile, { force: true });
});

app.on('window-all-closed', () => app.quit());
