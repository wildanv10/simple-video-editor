const $ = (id) => document.getElementById(id);

const video = $('video');
const timeline = $('timeline');
const MIN_LENGTH = 0.1;

let file = null; // { path, name, url }
let duration = 0;
let start = 0;
let end = 0;
let busy = false;
let outputPath = null;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fmt(t) {
  const cs = Math.floor(Math.max(0, t) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${h ? `${h}:` : ''}${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

function parseTime(text) {
  const parts = text.trim().split(':');
  if (!text.trim() || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums.reduce((acc, n) => acc * 60 + n, 0);
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

/* ---------- Rendering ---------- */

function renderRange() {
  const pct = (t) => (duration ? (t / duration) * 100 : 0);
  $('range').style.left = `${pct(start)}%`;
  $('range').style.width = `${pct(end) - pct(start)}%`;
  $('hStart').style.left = `${pct(start)}%`;
  $('hEnd').style.left = `${pct(end)}%`;
  if (document.activeElement !== $('startInput')) $('startInput').value = fmt(start);
  if (document.activeElement !== $('endInput')) $('endInput').value = fmt(end);
  $('startInput').classList.remove('invalid');
  $('endInput').classList.remove('invalid');
  $('length').textContent = fmt(end - start);
}

function renderPlayhead() {
  const t = video.currentTime || 0;
  $('playhead').style.left = `${duration ? (t / duration) * 100 : 0}%`;
  $('current').textContent = `${fmt(t)} / ${fmt(duration)}`;
  $('play').classList.toggle('is-playing', !video.paused);
  $('playLabel').textContent = video.paused ? 'Putar' : 'Jeda';
}

function tick() {
  renderPlayhead();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ---------- Loading ---------- */

let loading = false;

// Buka file dari path: main memastikan formatnya bisa diputar (remux ke MP4 sementara bila perlu).
async function openPath(filePath) {
  if (!filePath || loading || busy) return;
  loading = true;
  file = null;
  duration = 0;
  outputPath = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('reveal').hidden = true;
  $('bar').hidden = true;
  $('open').disabled = true;
  $('controls').classList.add('disabled');
  $('stage').classList.remove('loaded');
  setStatus('Menyiapkan video…');

  const info = await window.api.prepare(filePath);
  loading = false;
  $('open').disabled = false;
  if (info.error) {
    setStatus(info.error, 'error');
    return;
  }
  file = info;
  $('filename').textContent = info.name;
  setStatus('Memuat video…');
  video.src = info.url;
}

video.addEventListener('loadedmetadata', () => {
  duration = video.duration;
  start = 0;
  end = duration;
  $('stage').classList.add('loaded');
  $('controls').classList.remove('disabled');
  setStatus(file.converted
    ? 'Format file diubah ke MP4 agar bisa diputar. Hasil simpan berformat MP4 normal.'
    : 'Geser pegangan di slider untuk menentukan bagian yang disimpan.');
  renderRange();
});

video.addEventListener('error', () => {
  $('controls').classList.add('disabled');
  setStatus('Video tidak bisa dimuat (format/codec tidak didukung pemutar).', 'error');
});

$('open').addEventListener('click', async () => openPath(await window.api.pickFile()));

const stage = $('stage');
window.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('dragging'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  stage.classList.remove('dragging');
  const dropped = e.dataTransfer.files[0];
  if (dropped) openPath(window.api.pathForFile(dropped));
});

/* ---------- Playback ---------- */

function seek(t) {
  video.currentTime = clamp(t, 0, duration);
}

function togglePlay() {
  if (!duration) return;
  if (video.paused) {
    if (video.ended) seek(0);
    video.play();
  } else {
    video.pause();
  }
}

$('play').addEventListener('click', togglePlay);
$('back10').addEventListener('click', () => seek(video.currentTime - 10));
$('fwd10').addEventListener('click', () => seek(video.currentTime + 10));
video.addEventListener('click', togglePlay);

/* ---------- Timeline ---------- */

function timeAt(e) {
  const r = timeline.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * duration;
}

function enableDrag(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(timeAt(ev));
    el.addEventListener('pointermove', move);
    el.addEventListener('lostpointercapture', () => el.removeEventListener('pointermove', move), { once: true });
    onMove(timeAt(e));
  });
}

function setStart(t) {
  start = clamp(t, 0, end - MIN_LENGTH);
  renderRange();
}

function setEnd(t) {
  end = clamp(t, start + MIN_LENGTH, duration);
  renderRange();
}

// Set lewat tombol/keyboard/ketik: jika melewati titik lawannya,
// titik lawan dikembalikan ke ujung video (awal = 0, akhir = durasi).
function markStart(t) {
  if (t >= end - MIN_LENGTH) {
    start = clamp(t, 0, duration - MIN_LENGTH);
    end = duration;
    renderRange();
  } else {
    setStart(t);
  }
}

function markEnd(t) {
  if (t <= start + MIN_LENGTH) {
    end = clamp(t, MIN_LENGTH, duration);
    start = 0;
    renderRange();
  } else {
    setEnd(t);
  }
}

enableDrag(timeline, seek);
enableDrag($('hStart'), (t) => { setStart(t); seek(start); });
enableDrag($('hEnd'), (t) => { setEnd(t); seek(end); });

$('setStart').addEventListener('click', () => markStart(video.currentTime));
$('setEnd').addEventListener('click', () => markEnd(video.currentTime));

for (const [input, apply] of [[$('startInput'), markStart], [$('endInput'), markEnd]]) {
  const commit = () => {
    const t = parseTime(input.value);
    if (t === null) {
      input.classList.add('invalid');
      return;
    }
    apply(t);
    input.blur();
    renderRange();
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  input.addEventListener('blur', renderRange);
}

/* ---------- Keyboard ---------- */

window.addEventListener('keydown', (e) => {
  if (!duration || busy || e.target.matches('input, select')) return;
  const step = e.shiftKey ? 0.04 : 10;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'i': case 'I': markStart(video.currentTime); break;
    case 'o': case 'O': markEnd(video.currentTime); break;
    case 'j': case 'J': seek(video.currentTime - 10); break;
    case 'l': case 'L': seek(video.currentTime + 10); break;
    case 'ArrowLeft': e.preventDefault(); seek(video.currentTime - step); break;
    case 'ArrowRight': e.preventDefault(); seek(video.currentTime + step); break;
  }
});

/* ---------- Export ---------- */

function setBusy(on) {
  busy = on;
  $('export').hidden = on;
  $('cancel').hidden = !on;
  $('timeline').classList.toggle('locked', on);
  for (const el of document.querySelectorAll('button, input, select')) {
    if (el.id !== 'cancel') el.disabled = on;
  }
  $('bar').hidden = !on;
  $('fill').style.width = '0';
}

window.api.onProgress((seconds) => {
  const pct = clamp((seconds / (end - start)) * 100, 0, 100);
  $('fill').style.width = `${pct}%`;
  setStatus(`Memproses… ${Math.round(pct)}%`);
});

$('export').addEventListener('click', async () => {
  if (!file || busy) return;
  video.pause();
  $('reveal').hidden = true;
  setBusy(true);
  setStatus('Memilih lokasi simpan…');

  const result = await window.api.trim({ input: file.path, start, end });

  setBusy(false);
  if (result.ok) {
    outputPath = result.output;
    $('reveal').hidden = false;
    setStatus(`Selesai: ${result.output}`, 'ok');
  } else if (result.canceled) {
    setStatus('Dibatalkan.');
  } else {
    setStatus(result.error, 'error');
  }
});

$('cancel').addEventListener('click', () => window.api.cancel());
$('reveal').addEventListener('click', () => outputPath && window.api.reveal(outputPath));
