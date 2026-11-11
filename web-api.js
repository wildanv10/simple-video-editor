// Browser backend for window.api, used when the app runs as a web page instead of inside
// Electron (where preload.js provides window.api). Everything runs on the user's machine
// with ffmpeg.wasm: files are never uploaded.
//
// It speaks the same API as the desktop app, except that "paths" are File objects.

(() => {
  if (window.api) return; // running inside Electron

  const Plan = window.VTPlan;
  const Media = window.VTMedia;
  const NATIVE_FORMATS = /mp4|matroska|webm|ogg/; // containers <video> plays on its own

  const library = new Map(); // media id -> { id, name, ext, url, blob, path, ...stream info }
  let nextId = 1;
  let progressCallback = () => {};
  let statusCallback = () => {};
  let exporting = false;
  let cancelled = false;

  const extOf = (name) => (/\.[^.\\/]+$/.exec(name)?.[0] || '').toLowerCase();
  const baseName = (name) => name.replace(/\.[^.\\/]+$/, '');
  const tail = (text, lines) => text.trim().split('\n').slice(-lines).join('\n');

  const MIME = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime' };
  const mimeFor = (ext) => MIME[ext] || 'application/octet-stream';

  /* ---------- ffmpeg.wasm engine ---------- */

  let ffmpeg = null;
  let loading = null;
  const logListeners = new Set();

  // ffmpeg.wasm runs one command at a time.
  let queue = Promise.resolve();
  function enqueue(job) {
    const result = queue.then(job, job);
    queue = result.catch(() => {});
    return result;
  }

  const loadScript = (src) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });

  async function mountFile(instance, mountPoint, file) {
    try { await instance.createDir(mountPoint); } catch { /* already there */ }
    await instance.mount('WORKERFS', { files: [file] }, mountPoint);
  }

  async function unmountFile(mountPoint) {
    try {
      await ffmpeg.unmount(mountPoint);
      await ffmpeg.deleteDir(mountPoint);
    } catch { /* not mounted */ }
  }

  // Loading is lazy: the 30 MB engine is only fetched when the first file is imported.
  // After a cancelled export the engine is restarted, so every file is mounted again.
  async function engine() {
    if (ffmpeg?.loaded) return ffmpeg;
    if (!loading) {
      loading = (async () => {
        statusCallback('Loading the video engine…');
        if (!window.FFmpegWASM) await loadScript('vendor/ffmpeg/ffmpeg.js');
        const instance = new window.FFmpegWASM.FFmpeg();
        instance.on('log', ({ message }) => logListeners.forEach((fn) => fn(message)));
        await instance.load({
          coreURL: new URL('vendor/ffmpeg/ffmpeg-core.js', location.href).href,
          wasmURL: new URL('vendor/ffmpeg/ffmpeg-core.wasm', location.href).href,
        });
        for (const media of library.values()) await mountFile(instance, media.dir, media.blob);
        ffmpeg = instance;
        return instance;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  // Run one ffmpeg command; resolve with its exit code and log.
  async function exec(args, onLine) {
    const instance = await engine();
    const lines = [];
    const listener = (message) => {
      lines.push(message);
      onLine?.(message);
    };
    logListeners.add(listener);
    try {
      return { code: await instance.exec(args), log: lines.join('\n') };
    } finally {
      logListeners.delete(listener);
    }
  }

  const timeOf = (line) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  };

  /* ---------- Importing ---------- */

  function thumbnailOf(url, duration) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      const finish = (data) => {
        video.removeAttribute('src');
        video.load();
        resolve(data);
      };
      video.muted = true;
      video.preload = 'auto';
      video.addEventListener('error', () => finish(null));
      video.addEventListener('loadeddata', () => { video.currentTime = Math.min(1, duration / 3); });
      video.addEventListener('seeked', () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.height = 180;
          canvas.width = Math.round(180 * (video.videoWidth / video.videoHeight || 16 / 9));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.8));
        } catch {
          finish(null);
        }
      }, { once: true });
      video.src = url;
      setTimeout(() => finish(null), 8000);
    });
  }

  // Probe a file, make it playable (remux unsupported containers to MP4), and register it.
  function prepare(file) {
    if (!(file instanceof File)) return Promise.resolve({ error: 'This file is not a recognized video.' });
    return enqueue(async () => {
      const id = nextId++;
      const dir = `/w${id}`;
      let ext = extOf(file.name) || '.bin';
      let blob = new File([file], `work${ext}`); // a renamed view of the file, no copy
      await mountFile(await engine(), dir, blob);

      const probe = await exec(['-hide_banner', '-i', `${dir}/work${ext}`]);
      const info = Media.parseProbe(probe.log);
      const fail = async (error) => {
        await unmountFile(dir);
        return { error };
      };
      if (!info) return fail('This file is not a recognized video.');
      if (!info.hasVideo) return fail('This file has no video stream.');
      if (!(info.duration > 0)) return fail('Could not read the duration of this video.');

      let converted = false;
      if (!NATIVE_FORMATS.test(info.format)) {
        // e.g. MPEG-TS from an HLS download renamed to .mp4: change the wrapper only.
        statusCallback('Converting the file so it can be played…');
        const out = `/remux_${id}.mp4`;
        const remux = await exec([
          '-hide_banner', '-nostdin', '-y', '-i', `${dir}/work${ext}`,
          '-map', '0:v:0', '-map', '0:a?', '-sn', '-dn', '-c', 'copy', '-movflags', '+faststart', out,
        ]);
        if (remux.code !== 0) return fail(`Failed to prepare the video:\n${tail(remux.log, 3)}`);
        const data = await ffmpeg.readFile(out);
        await ffmpeg.deleteFile(out);
        await unmountFile(dir);
        ext = '.mp4';
        blob = new File([data], 'work.mp4', { type: 'video/mp4' });
        await mountFile(ffmpeg, dir, blob);
        converted = true;
      }

      const url = URL.createObjectURL(blob);
      const entry = {
        id, name: file.name, ext, dir, blob, url, converted,
        path: `${dir}/work${ext}`,
        duration: info.duration, width: info.width, height: info.height, fps: info.fps,
        hasAudio: info.hasAudio, sig: info.sig,
      };
      library.set(id, entry);
      return {
        id, name: file.name, url, converted,
        duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio,
        thumb: await thumbnailOf(url, info.duration),
      };
    });
  }

  function release(id) {
    const media = library.get(id);
    if (!media) return Promise.resolve();
    library.delete(id);
    URL.revokeObjectURL(media.url);
    return enqueue(() => unmountFile(media.dir));
  }

  function pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'video/*,.mkv,.ts,.avi,.flv,.wmv,.mpg,.mpeg,.m4v,.mov';
      input.addEventListener('change', () => resolve([...input.files]), { once: true });
      input.addEventListener('cancel', () => resolve([]), { once: true });
      input.click();
    });
  }

  /* ---------- Exporting ---------- */

  const encoder = new TextEncoder();

  // The engine here runs on one thread, so when a re-encode cannot be avoided, favour speed.
  const WEB_VIDEO_ARGS = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23'];

  // Same plan as the desktop app, run in the browser. Returns { code, data, log, ...plan }.
  async function runExport(clips, plan, ext) {
    const final = `/final${ext}`;
    const made = [];
    const stage = (args, scale) => exec(args, (line) => {
      const t = timeOf(line);
      if (t !== null) progressCallback(Math.min(1, Math.max(0, scale(t))), plan);
    });

    let result;
    if (plan.method === 'copy') {
      const ordered = [...clips].sort(Plan.byTime);
      const total = ordered.reduce((sum, c) => sum + Plan.sourceLength(c), 0);
      if (ordered.length === 1) {
        result = await stage([...Plan.cutArgs(ordered[0]), final], (t) => t / total);
      } else {
        const parts = [];
        let done = 0;
        for (const [i, c] of ordered.entries()) {
          const part = `/part${i}${ext}`;
          made.push(part);
          result = await stage([...Plan.cutArgs(c), part], (t) => ((done + t) / total) * 0.8);
          if (result.code !== 0 || cancelled) break;
          done += Plan.sourceLength(c);
          parts.push(part);
        }
        if (result.code === 0 && !cancelled) {
          made.push('/parts.txt');
          await ffmpeg.writeFile('/parts.txt', encoder.encode(Plan.concatListText(parts)));
          result = await stage([...Plan.concatArgs('/parts.txt'), final], (t) => 0.8 + (t / total) * 0.2);
        }
      }
    } else {
      const total = Plan.totalLength(clips);
      result = await stage([...Plan.buildReencodeArgs(clips, { videoArgs: WEB_VIDEO_ARGS }), final], (t) => t / total);
    }

    made.push(final);
    try {
      if (result.code === 0 && !cancelled) result.data = await ffmpeg.readFile(final);
    } finally {
      // The engine is gone if the export was cancelled meanwhile.
      for (const file of made) await ffmpeg?.deleteFile(file).catch(() => {});
    }
    return { ...result, ...plan };
  }

  function download(blob, name) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }

  async function exportVideo({ clips }) {
    if (exporting) return { error: 'Another export is still running.' };
    if (!Array.isArray(clips) || clips.length === 0) return { error: 'The timeline is empty.' };

    let resolved;
    try {
      resolved = Plan.normalizeClips(clips, (id) => library.get(id));
    } catch (err) {
      return { error: err.message };
    }

    // Stream copy keeps the source container; re-encoding always writes MP4.
    const lead = library.get([...resolved].sort(Plan.byLayer)[0].mediaId);
    const plan = Plan.planExport(resolved); // { method: 'copy' | 'reencode', why }
    const ext = plan.method === 'copy' ? lead.ext : '.mp4';
    const suggestedName = `${baseName(lead.name)}_trim${ext}`;

    exporting = true;
    cancelled = false;
    try {
      // Ask where to save first: the picker needs the click that started the export.
      let handle = null;
      if (window.showSaveFilePicker) {
        try {
          handle = await window.showSaveFilePicker({
            suggestedName,
            types: [{ description: 'Video', accept: { [mimeFor(ext)]: [ext] } }],
          });
        } catch (err) {
          if (err.name === 'AbortError') return { canceled: true };
          // Not allowed here (e.g. an iframe): fall back to a normal download.
        }
      }

      progressCallback(0, plan); // tells the UI right away whether this is lossless or a re-encode
      const result = await enqueue(() => runExport(resolved, plan, ext)).catch((err) => {
        if (cancelled) return { code: -1, log: '' };
        throw err;
      });
      if (cancelled) return { canceled: true };
      if (result.code !== 0) return { error: tail(result.log, 4) || `ffmpeg exited with code ${result.code}` };

      const blob = new Blob([result.data], { type: mimeFor(ext) });
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { ok: true, output: handle.name, method: result.method, why: result.why };
      }
      download(blob, suggestedName);
      return { ok: true, output: suggestedName, method: result.method, why: result.why };
    } catch (err) {
      return { error: `Export failed: ${err.message}` };
    } finally {
      exporting = false;
    }
  }

  // Stopping ffmpeg.wasm means restarting it; engine() mounts the files again on demand.
  function cancel() {
    if (!exporting) return Promise.resolve();
    cancelled = true;
    ffmpeg?.terminate();
    ffmpeg = null;
    return Promise.resolve();
  }

  window.api = {
    isWeb: true,
    canReveal: false, // a browser cannot open the downloads folder
    pickFiles,
    pathForFile: (file) => file, // in the browser a dropped File is used as it is
    prepare,
    release,
    exportVideo,
    cancel,
    reveal: () => Promise.resolve(),
    onProgress: (cb) => { progressCallback = cb; },
    onStatus: (cb) => { statusCallback = cb; },
  };
})();
