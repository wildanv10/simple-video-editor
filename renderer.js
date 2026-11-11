'use strict';

const $ = (id) => document.getElementById(id);
const MIN_CLIP = 0.1; // shortest clip, in source seconds
const FRAME = 0.04;

const state = {
  media: new Map(), // id -> { id, name, url, duration, width, height, hasAudio, thumb }
  tracks: [], // timeline line ids, lowest layer first (the last one is drawn on top)
  clips: [], // { id, mediaId, track, start, in, out, speed, volume, fadeIn, fadeOut }
  selectedId: null,
  playhead: 0, // timeline seconds
  pps: 40, // timeline zoom, pixels per second
  busy: false, // exporting: edits are locked
};
let nextClipId = 1;
let nextTrackId = 1;
let importing = false;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad = (n) => String(n).padStart(2, '0');

function fmt(t) {
  const cs = Math.floor(Math.max(0, t) * 100 + 1e-6);
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h ? `${h}:${pad(m)}` : m}:${pad(s)}.${pad(cs % 100)}`;
}

function parseTime(text) {
  const parts = text.trim().split(':');
  if (!text.trim() || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums.reduce((acc, n) => acc * 60 + n, 0);
}

const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ---------- Timeline model ---------- */

let layoutCache = null;

// A clip occupies [start, start + length) on its line; length is its source span divided by speed.
function layout() {
  if (!layoutCache) {
    const items = state.clips.map((clip) => {
      const len = (clip.out - clip.in) / clip.speed;
      return { clip, start: clip.start, len, end: clip.start + len };
    });
    const byTrack = new Map(state.tracks.map((id) => [id, []]));
    for (const item of items) byTrack.get(item.clip.track)?.push(item);
    for (const list of byTrack.values()) list.sort((a, b) => a.start - b.start);
    layoutCache = { items, byTrack, total: items.reduce((max, it) => Math.max(max, it.end), 0) };
  }
  return layoutCache;
}

const selectedClip = () => state.clips.find((c) => c.id === state.selectedId) || null;
const itemOf = (clip) => layout().items.find((it) => it.clip.id === clip.id);

// Free space beside a clip on its line.
function neighbours(clip) {
  const list = layout().byTrack.get(clip.track) || [];
  const i = list.findIndex((it) => it.clip.id === clip.id);
  return { prevEnd: i > 0 ? list[i - 1].end : 0, nextStart: i >= 0 && i < list.length - 1 ? list[i + 1].start : Infinity };
}

// Nearest start time to `desired` where a clip of length `len` fits on a line without overlapping.
function findSlot(trackId, desired, len, ignoreId) {
  const others = (layout().byTrack.get(trackId) || []).filter((it) => it.clip.id !== ignoreId);
  const free = (s) => others.every((o) => s >= o.end - 1e-6 || s + len <= o.start + 1e-6);
  desired = Math.max(0, desired);
  if (free(desired)) return desired;
  const candidates = [0, ...others.flatMap((o) => [o.end, o.start - len])].filter((s) => s >= 0 && free(s));
  return candidates.reduce((best, s) => (Math.abs(s - desired) < Math.abs(best - desired) ? s : best));
}

// Magnet: pull a clip's edges onto nearby clip edges, the playhead, or time zero.
function snapStart(desired, len, ignoreId) {
  const threshold = 10 / state.pps;
  const edges = [0, state.playhead];
  for (const it of layout().items) {
    if (it.clip.id !== ignoreId) edges.push(it.start, it.end);
  }
  let best = desired;
  let bestDistance = threshold;
  for (const edge of edges) {
    if (Math.abs(desired - edge) < bestDistance) {
      best = edge;
      bestDistance = Math.abs(desired - edge);
    }
    if (Math.abs(desired + len - edge) < bestDistance) {
      best = edge - len;
      bestDistance = Math.abs(desired + len - edge);
    }
  }
  return Math.max(0, best);
}

/* ---------- Undo / redo ---------- */

const history = { undo: [], redo: [] };
const snap = () => JSON.stringify({ tracks: state.tracks, clips: state.clips, selectedId: state.selectedId });

function recordUndo(before) {
  history.undo.push(before);
  if (history.undo.length > 100) history.undo.shift();
  history.redo = [];
}

function restore(json) {
  const saved = JSON.parse(json);
  state.tracks = saved.tracks;
  state.clips = saved.clips;
  state.selectedId = saved.selectedId;
  afterEdit();
}

function undo() {
  if (state.busy || !history.undo.length) return;
  history.redo.push(snap());
  restore(history.undo.pop());
}

function redo() {
  if (state.busy || !history.redo.length) return;
  history.undo.push(snap());
  restore(history.redo.pop());
}

// Run an edit as one undoable step.
function edit(mutate) {
  if (state.busy) return;
  const before = snap();
  mutate();
  recordUndo(before);
  afterEdit();
}

function afterEdit() {
  state.tracks = state.tracks.filter((id) => state.clips.some((c) => c.track === id)); // empty lines disappear
  layoutCache = null;
  state.playhead = clamp(state.playhead, 0, layout().total);
  if (!state.clips.some((c) => c.id === state.selectedId)) state.selectedId = null;
  pause();
  renderTimeline();
  renderProps();
  syncPlayers();
  fitCanvas();
  updateButtons();
}

/* ---------- Edits ---------- */

// Add media to an existing line (trackId) or to a new line on top (trackId === null).
function addMediaClip(mediaId, trackId = null, start = state.playhead) {
  const media = state.media.get(mediaId);
  if (!media) return;
  edit(() => {
    let track = trackId;
    let at = Math.max(0, start);
    if (track === null) {
      track = nextTrackId++;
      state.tracks.push(track);
    } else {
      at = findSlot(track, at, media.duration, null);
    }
    const clip = { id: nextClipId++, mediaId, track, start: at, in: 0, out: media.duration, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 };
    state.clips.push(clip);
    state.selectedId = clip.id;
  });
}

// Delete closes the gap on that line; Shift+Delete leaves it.
function deleteSelected(ripple = true) {
  const clip = selectedClip();
  if (!clip) return;
  const item = itemOf(clip);
  edit(() => {
    state.clips = state.clips.filter((c) => c.id !== clip.id);
    if (ripple) {
      for (const other of state.clips) {
        if (other.track === clip.track && other.start >= item.end - 1e-6) other.start -= item.len;
      }
    }
    state.selectedId = null;
  });
}

// Split the selected clip (or the topmost clip under the playhead) at the playhead.
function splitAtPlayhead() {
  const t = state.playhead;
  const under = layout().items.filter((it) => t > it.start && t < it.end);
  const target = under.find((it) => it.clip.id === state.selectedId)
    || under.sort((a, b) => state.tracks.indexOf(b.clip.track) - state.tracks.indexOf(a.clip.track))[0];
  if (!target) return;
  const { clip } = target;
  const at = clip.in + (t - target.start) * clip.speed;
  if (at - clip.in < MIN_CLIP || clip.out - at < MIN_CLIP) return;
  edit(() => {
    const right = { ...clip, id: nextClipId++, start: t, in: at, fadeIn: 0 };
    clip.out = at;
    clip.fadeOut = 0;
    state.clips.push(right);
    state.selectedId = clip.id;
  });
}

// Trimming never ripples: the remaining footage keeps its place on the timeline.
function trimStartTo(clip, orig, newIn) {
  const { prevEnd } = neighbours(clip);
  newIn = clamp(newIn, 0, orig.out - MIN_CLIP);
  let start = orig.start + (newIn - orig.in) / clip.speed;
  if (start < prevEnd) {
    start = prevEnd;
    newIn = orig.in + (prevEnd - orig.start) * clip.speed;
  }
  clip.in = newIn;
  clip.start = start;
}

function trimEndTo(clip, orig, newOut) {
  const { nextStart } = neighbours(clip);
  const duration = state.media.get(clip.mediaId).duration;
  const maxOut = Math.min(duration, orig.in + (nextStart - orig.start) * clip.speed);
  clip.out = clamp(newOut, orig.in + MIN_CLIP, maxOut);
}

// I / O: trim the selected clip's start or end to the playhead.
function trimToPlayhead(edge) {
  const clip = selectedClip();
  const item = clip && itemOf(clip);
  if (!item || state.playhead <= item.start || state.playhead >= item.end) return;
  const at = clip.in + (state.playhead - item.start) * clip.speed;
  if (edge === 'start' ? clip.out - at < MIN_CLIP : at - clip.in < MIN_CLIP) return;
  const orig = { in: clip.in, out: clip.out, start: clip.start };
  edit(() => (edge === 'start' ? trimStartTo(clip, orig, at) : trimEndTo(clip, orig, at)));
}

/* ---------- Preview players (one <video> per line) ---------- */

const canvas = $('canvas');
const players = new Map(); // line id -> { video, mediaId, pending }
const clock = { playing: false, baseTime: 0, baseNow: 0 };

function ensurePlayer(trackId) {
  let player = players.get(trackId);
  if (player) return player;
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.className = 'off';
  player = { video, mediaId: null, pending: null };
  video.addEventListener('loadedmetadata', () => {
    if (player.pending !== null) {
      video.currentTime = player.pending;
      player.pending = null;
    }
    syncPlayers();
  });
  video.addEventListener('seeked', () => {
    if (!clock.playing) syncPlayers();
  });
  video.addEventListener('error', () => {
    if (video.getAttribute('src')) showToast('This video cannot be played in the preview (unsupported codec).', { kind: 'error', close: true });
  });
  canvas.appendChild(video);
  players.set(trackId, player);
  return player;
}

function hidePlayer(player) {
  player.video.pause();
  player.video.classList.add('off');
}

// Fades show as opacity and volume ramps, so a fading clip reveals the lines below it.
function applyEffects(video, clip, item, t) {
  let f = 1;
  if (clip.fadeIn > 0) f = Math.min(f, (t - item.start) / clip.fadeIn);
  if (clip.fadeOut > 0) f = Math.min(f, (item.end - t) / clip.fadeOut);
  f = clamp(f, 0, 1);
  video.style.opacity = String(f);
  video.volume = clamp(clip.volume * f, 0, 1);
  video.muted = clip.volume === 0;
}

function drive(player, item, t) {
  const { clip } = item;
  const media = state.media.get(clip.mediaId);
  const video = player.video;
  const want = clamp(clip.in + (t - item.start) * clip.speed, clip.in, clip.out);
  video.classList.remove('off');
  if (player.mediaId !== media.id) {
    player.mediaId = media.id;
    player.pending = want;
    video.src = media.url;
    return;
  }
  if (player.pending !== null) {
    player.pending = want;
    return;
  }
  video.defaultPlaybackRate = clip.speed;
  video.playbackRate = clip.speed;
  const drift = Math.abs(video.currentTime - want);
  if (clock.playing) {
    if (drift > 0.3 && !video.seeking) video.currentTime = want;
    if (video.paused) video.play().catch(() => {});
  } else {
    if (!video.paused) video.pause();
    if (drift > 0.04 && !video.seeking) video.currentTime = want;
  }
  applyEffects(video, clip, item, t);
}

// Point every line's player at what the playhead is over.
function syncPlayers() {
  const { byTrack, total } = layout();
  const t = Math.min(state.playhead, Math.max(0, total - 1e-4));
  for (const [id, player] of players) {
    if (state.tracks.includes(id)) continue;
    player.video.pause();
    player.video.removeAttribute('src');
    player.video.remove();
    players.delete(id);
  }
  state.tracks.forEach((trackId, index) => {
    const player = ensurePlayer(trackId);
    player.video.style.zIndex = String(index + 1);
    const item = byTrack.get(trackId).find((it) => t >= it.start && t < it.end);
    if (item) drive(player, item, t);
    else hidePlayer(player);
  });
  $('stage').classList.toggle('has-video', state.clips.length > 0);
}

// The canvas takes the shape of the first clip on the lowest line (the export uses the same).
function baseMedia() {
  const { byTrack } = layout();
  for (const id of state.tracks) {
    const list = byTrack.get(id);
    if (list.length) return state.media.get(list[0].clip.mediaId);
  }
  return null;
}

function fitCanvas() {
  const media = baseMedia();
  if (!media) return;
  const stage = $('stage');
  const ratio = media.width && media.height ? media.width / media.height : 16 / 9;
  let w = stage.clientWidth;
  let h = w / ratio;
  if (h > stage.clientHeight) {
    h = stage.clientHeight;
    w = h * ratio;
  }
  canvas.style.width = `${Math.floor(w)}px`;
  canvas.style.height = `${Math.floor(h)}px`;
}

// Playback is driven by one clock; the players follow it.
function play() {
  const { total } = layout();
  if (!total) return;
  if (state.playhead >= total - 0.05) state.playhead = 0;
  clock.playing = true;
  clock.baseTime = state.playhead;
  clock.baseNow = performance.now();
  syncPlayers();
}

function pause() {
  if (!clock.playing) return;
  clock.playing = false;
  for (const player of players.values()) player.video.pause();
}

const togglePlay = () => (clock.playing ? pause() : play());

function seekTo(t) {
  state.playhead = clamp(t, 0, layout().total);
  if (clock.playing) {
    clock.baseTime = state.playhead;
    clock.baseNow = performance.now();
  }
  syncPlayers();
}

const skip = (seconds) => layout().total && seekTo(state.playhead + seconds);

// Show one frame of a clip's source while its edge is being dragged.
function previewSource(clip, time) {
  const player = ensurePlayer(clip.track);
  const media = state.media.get(clip.mediaId);
  player.video.classList.remove('off');
  if (player.mediaId !== media.id) {
    player.mediaId = media.id;
    player.pending = time;
    player.video.src = media.url;
  } else if (player.pending !== null) {
    player.pending = time;
  } else {
    player.video.pause();
    player.video.currentTime = clamp(time, 0, media.duration);
  }
}

let lastPlayhead = -1;

function frame(now) {
  if (clock.playing) {
    const t = clock.baseTime + (now - clock.baseNow) / 1000;
    const { total } = layout();
    if (t >= total) {
      state.playhead = total;
      clock.playing = false;
    } else {
      state.playhead = t;
    }
    syncPlayers();
  }
  updateTime();
  updatePlayhead();
  if (state.playhead !== lastPlayhead) {
    lastPlayhead = state.playhead;
    updateButtons(); // Split depends on where the playhead is
  }
  requestAnimationFrame(frame);
}

/* ---------- Timeline rendering ---------- */

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const scroller = $('tl-scroll');
const content = $('tl-content');
const lanesEl = $('lanes');
const newLane = $('new-lane');
const ghost = Object.assign(document.createElement('div'), { id: 'drop-ghost', hidden: true });
lanesEl.appendChild(ghost);

function renderRuler(width) {
  const ruler = $('ruler');
  ruler.textContent = '';
  const major = STEPS.find((s) => s * state.pps >= 90) || 3600;
  const subdivisions = [5, 4, 2, 1].find((n) => (major / n) * state.pps >= 12) || 1;
  const minor = major / subdivisions;
  const end = width / state.pps;
  const frag = document.createDocumentFragment();
  for (let i = 0; i * minor <= end; i++) {
    const t = i * minor;
    const isMajor = i % subdivisions === 0;
    const tick = document.createElement('div');
    tick.className = isMajor ? 'tick major' : 'tick';
    tick.style.left = `${t * state.pps}px`;
    frag.appendChild(tick);
    if (isMajor) {
      const label = document.createElement('div');
      label.className = 'tick-label';
      label.textContent = major < 1 ? fmt(t).slice(0, -1) : fmt(t).slice(0, -3);
      label.style.left = `${t * state.pps}px`;
      frag.appendChild(label);
    }
  }
  ruler.appendChild(frag);
}

function renderTimeline() {
  const { byTrack, total } = layout();
  const width = Math.max(scroller.clientWidth, Math.ceil(total * state.pps) + 160);
  content.style.width = `${width}px`;
  renderRuler(width);
  lanesEl.querySelectorAll('.lane:not(.new-lane)').forEach((el) => el.remove());
  for (const trackId of [...state.tracks].reverse()) { // highest line first
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.dataset.track = trackId;
    for (const item of byTrack.get(trackId)) lane.appendChild(clipElement(item));
    lanesEl.appendChild(lane);
  }
  ghost.hidden = true;
  updatePlayhead();
  updateTime();
}

function clipElement(item) {
  const { clip } = item;
  const media = state.media.get(clip.mediaId);
  const el = document.createElement('div');
  el.className = `clip${clip.id === state.selectedId ? ' selected' : ''}`;
  el.dataset.id = clip.id;
  el.style.left = `${item.start * state.pps}px`;
  el.style.width = `${item.len * state.pps}px`;
  if (media.thumb) el.style.backgroundImage = `url(${JSON.stringify(media.thumb)})`;

  const label = document.createElement('div');
  label.className = 'clip-label';
  label.textContent = media.name;
  el.appendChild(label);

  const chips = [];
  if (clip.speed !== 1) chips.push(`${clip.speed}×`);
  if (clip.fadeIn > 0 || clip.fadeOut > 0) chips.push('Fade');
  if (clip.volume === 0) chips.push('Muted');
  else if (clip.volume < 1) chips.push(`${Math.round(clip.volume * 100)}%`);
  if (chips.length) {
    const fx = document.createElement('div');
    fx.className = 'clip-fx';
    for (const text of chips) fx.appendChild(Object.assign(document.createElement('span'), { textContent: text }));
    el.appendChild(fx);
  }

  for (const edge of ['start', 'end']) {
    const handle = document.createElement('div');
    handle.className = `trim trim-${edge}`;
    handle.addEventListener('pointerdown', (e) => beginTrim(e, item, edge, el, handle));
    el.appendChild(handle);
  }
  el.addEventListener('pointerdown', (e) => beginMove(e, item, el));
  return el;
}

function updatePlayhead() {
  $('playhead').style.left = `${state.playhead * state.pps}px`;
  $('play').classList.toggle('is-playing', clock.playing);
  if (clock.playing) {
    const x = state.playhead * state.pps;
    if (x > scroller.scrollLeft + scroller.clientWidth - 40 || x < scroller.scrollLeft) {
      scroller.scrollLeft = Math.max(0, x - 80);
    }
  }
}

function updateTime() {
  $('time-now').textContent = fmt(state.playhead);
  $('time-total').textContent = fmt(layout().total);
}

function updateSelection() {
  for (const el of lanesEl.querySelectorAll('.clip')) el.classList.toggle('selected', Number(el.dataset.id) === state.selectedId);
}

function updateButtons() {
  const has = state.clips.length > 0;
  const splittable = layout().items.some((it) => state.playhead > it.start + MIN_CLIP && state.playhead < it.end - MIN_CLIP);
  $('undo').disabled = state.busy || !history.undo.length;
  $('redo').disabled = state.busy || !history.redo.length;
  $('split').disabled = !splittable;
  $('delete').disabled = !selectedClip();
  $('export').disabled = !has;
  for (const id of ['play', 'to-start', 'back10', 'fwd10', 'zoom-fit']) $(id).disabled = !has;
}

/* ---------- Zoom ---------- */

function setZoom(pps, anchorX = scroller.clientWidth / 2) {
  const t = (scroller.scrollLeft + anchorX) / state.pps;
  state.pps = clamp(pps, 2, 400);
  renderTimeline();
  scroller.scrollLeft = Math.max(0, t * state.pps - anchorX);
}

$('zoom-in').addEventListener('click', () => setZoom(state.pps * 1.5));
$('zoom-out').addEventListener('click', () => setZoom(state.pps / 1.5));
$('zoom-fit').addEventListener('click', () => {
  const { total } = layout();
  if (total) setZoom((scroller.clientWidth - 160) / total, 0);
  scroller.scrollLeft = 0;
});
scroller.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - scroller.getBoundingClientRect().left);
}, { passive: false });

/* ---------- Timeline interaction ---------- */

const timeAtX = (clientX) => (clientX - content.getBoundingClientRect().left) / state.pps;

// The line (or the "new line" strip) nearest to a pointer height.
function laneAtY(clientY) {
  let best = null;
  let bestDistance = Infinity;
  for (const el of lanesEl.querySelectorAll('.lane')) {
    const rect = el.getBoundingClientRect();
    const distance = Math.abs(clientY - (rect.top + rect.height / 2));
    if (distance < bestDistance) {
      best = el;
      bestDistance = distance;
    }
  }
  return { el: best, trackId: best === newLane ? null : Number(best.dataset.track) };
}

function showGhost(laneEl, start, len) {
  ghost.hidden = false;
  ghost.style.left = `${start * state.pps}px`;
  ghost.style.width = `${Math.max(4, len * state.pps)}px`;
  ghost.style.top = `${laneEl.offsetTop + 4}px`;
  ghost.style.height = `${laneEl.offsetHeight - 8}px`;
  for (const el of lanesEl.querySelectorAll('.lane')) el.classList.toggle('drop-target', el === laneEl);
}

function hideGhost() {
  ghost.hidden = true;
  for (const el of lanesEl.querySelectorAll('.lane')) el.classList.remove('drop-target');
}

// Where a clip of length `len` would land if dropped under the pointer.
function dropSlot(clientX, clientY, len, ignoreId, offset = 0) {
  const lane = laneAtY(clientY);
  const desired = snapStart(Math.max(0, timeAtX(clientX) - offset), len, ignoreId);
  const start = lane.trackId === null ? desired : findSlot(lane.trackId, desired, len, ignoreId);
  return { ...lane, start };
}

function enableScrub(el, deselect) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.clip')) return;
    e.preventDefault();
    if (deselect && state.selectedId !== null) {
      state.selectedId = null;
      updateSelection();
      renderProps();
      updateButtons();
    }
    el.setPointerCapture(e.pointerId);
    const move = (ev) => seekTo(clamp(timeAtX(ev.clientX), 0, layout().total));
    move(e);
    el.addEventListener('pointermove', move);
    el.addEventListener('lostpointercapture', () => el.removeEventListener('pointermove', move), { once: true });
  });
}
enableScrub($('ruler'), false);
enableScrub(lanesEl, true);

function select(clip) {
  state.selectedId = clip.id;
  updateSelection();
  renderProps();
  updateButtons();
}

// Drag a clip's edge to trim it. Neighbouring clips stay where they are.
function beginTrim(e, item, edge, el, handle) {
  if (state.busy) return;
  e.preventDefault();
  e.stopPropagation();
  const { clip } = item;
  select(clip);
  pause();
  const before = snap();
  const startX = e.clientX;
  const orig = { in: clip.in, out: clip.out, start: clip.start };
  handle.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const delta = ((ev.clientX - startX) / state.pps) * clip.speed;
    if (edge === 'start') {
      trimStartTo(clip, orig, orig.in + delta);
      el.style.left = `${clip.start * state.pps}px`;
      el.style.width = `${((clip.out - clip.in) / clip.speed) * state.pps}px`;
      previewSource(clip, clip.in);
    } else {
      trimEndTo(clip, orig, orig.out + delta);
      el.style.width = `${((clip.out - clip.in) / clip.speed) * state.pps}px`;
      previewSource(clip, Math.max(clip.in, clip.out - FRAME));
    }
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('lostpointercapture', () => {
    handle.removeEventListener('pointermove', move);
    if (snap() !== before) recordUndo(before);
    state.playhead = edge === 'start' ? clip.start : clip.start + (clip.out - clip.in) / clip.speed;
    afterEdit();
  }, { once: true });
}

// Click a clip to select it and park the playhead there; drag it to move it in time
// or onto another line (or the "new line" strip).
function beginMove(e, item, el) {
  if (state.busy || e.button !== 0) return;
  e.preventDefault();
  const { clip } = item;
  select(clip);
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let slot = null;
  el.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) < 4) return;
    if (!dragging) {
      dragging = true;
      el.classList.add('dragging');
    }
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    // The slot follows the clip's own left edge, not the pointer.
    slot = dropSlot(ev.clientX, ev.clientY, item.len, clip.id, (startX - content.getBoundingClientRect().left) / state.pps - item.start);
    showGhost(slot.el, slot.start, item.len);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('lostpointercapture', () => {
    el.removeEventListener('pointermove', move);
    el.style.transform = '';
    el.classList.remove('dragging');
    hideGhost();
    if (!dragging) {
      seekTo(clamp(timeAtX(e.clientX), item.start, item.end - 1e-3));
    } else if (slot && (slot.trackId !== clip.track || Math.abs(slot.start - clip.start) > 1e-6)) {
      edit(() => {
        if (slot.trackId === null) {
          slot.trackId = nextTrackId++;
          state.tracks.push(slot.trackId);
        }
        clip.track = slot.trackId;
        clip.start = slot.start;
      });
    } else {
      renderTimeline();
    }
  }, { once: true });
}

// Drop media from My media onto an existing line or the "new line" strip.
let draggedMediaId = null;

lanesEl.addEventListener('dragover', (e) => {
  const media = state.media.get(draggedMediaId);
  if (!media || !e.dataTransfer.types.includes('application/x-media-id')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const slot = dropSlot(e.clientX, e.clientY, media.duration, null);
  showGhost(slot.el, slot.start, media.duration);
});
lanesEl.addEventListener('dragleave', (e) => {
  if (!lanesEl.contains(e.relatedTarget)) hideGhost();
});
lanesEl.addEventListener('drop', (e) => {
  const media = state.media.get(Number(e.dataTransfer.getData('application/x-media-id')));
  if (!media) return;
  e.preventDefault();
  e.stopPropagation();
  const slot = dropSlot(e.clientX, e.clientY, media.duration, null);
  hideGhost();
  addMediaClip(media.id, slot.trackId, slot.start);
});

/* ---------- My media ---------- */

function renderMedia() {
  const list = $('media-list');
  list.textContent = '';
  $('media-empty').hidden = state.media.size > 0;
  for (const media of state.media.values()) {
    const item = document.createElement('div');
    item.className = 'media-item';
    item.draggable = true;
    item.title = 'Press + to add on a new line, or drag it onto the timeline';

    const thumb = document.createElement('div');
    thumb.className = 'media-thumb';
    if (media.thumb) thumb.style.backgroundImage = `url(${JSON.stringify(media.thumb)})`;
    const dur = document.createElement('span');
    dur.className = 'media-dur';
    dur.textContent = fmt(media.duration).replace(/\.\d+$/, '');
    const actions = document.createElement('div');
    actions.className = 'media-actions';
    const add = document.createElement('button');
    add.title = 'Add on a new line';
    add.innerHTML = icon('plus');
    add.addEventListener('click', () => addMediaClip(media.id));
    const remove = document.createElement('button');
    remove.title = 'Remove from My media';
    remove.innerHTML = icon('trash-2');
    remove.addEventListener('click', () => removeMedia(media.id));
    actions.append(add, remove);
    thumb.append(dur, actions);

    const name = document.createElement('div');
    name.className = 'media-name';
    name.textContent = media.name;
    item.append(thumb, name);

    item.addEventListener('dblclick', () => addMediaClip(media.id));
    item.addEventListener('dragstart', (e) => {
      draggedMediaId = media.id;
      e.dataTransfer.setData('application/x-media-id', String(media.id));
      e.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dragend', () => {
      draggedMediaId = null;
      hideGhost();
    });
    list.appendChild(item);
  }
}

function removeMedia(id) {
  if (state.busy) return;
  const used = state.clips.some((c) => c.mediaId === id);
  if (used && !window.confirm('This media is used on the timeline. Remove it and its clips?')) return;
  state.clips = state.clips.filter((c) => c.mediaId !== id);
  state.media.delete(id);
  history.undo = [];
  history.redo = [];
  for (const player of players.values()) {
    if (player.mediaId === id) {
      player.video.removeAttribute('src');
      player.video.load();
      player.mediaId = null;
      player.pending = null;
    }
  }
  window.api.release(id);
  renderMedia();
  afterEdit();
}

async function importPaths(paths) {
  if (importing || state.busy || !paths.length) return;
  importing = true;
  $('import').disabled = true;
  const errors = [];
  for (const [i, file] of paths.entries()) {
    showToast(`Importing ${i + 1} of ${paths.length}…`);
    const info = await window.api.prepare(file);
    if (info.error) {
      errors.push(`${file.split(/[\\/]/).pop()}: ${info.error}`);
      continue;
    }
    state.media.set(info.id, info);
    renderMedia();
    if (!state.clips.length) addMediaClip(info.id, null, 0); // the first import lands on the timeline
  }
  importing = false;
  $('import').disabled = false;
  if (errors.length) showToast(errors.join('\n'), { kind: 'error', close: true });
  else hideToast();
}

$('import').addEventListener('click', async () => importPaths(await window.api.pickFiles()));
$('media-collapse').addEventListener('click', () => {
  $('app').classList.toggle('media-collapsed');
  fitCanvas();
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  if (files.length) importPaths(files.map((f) => window.api.pathForFile(f)));
});

/* ---------- Properties panel ---------- */

function renderProps() {
  const clip = selectedClip();
  $('props-panel').hidden = !clip;
  if (!clip) return;
  const media = state.media.get(clip.mediaId);
  const len = (clip.out - clip.in) / clip.speed;

  $('prop-name').textContent = media.name;
  $('prop-meta').textContent = `${fmt(len)} on timeline · starts at ${fmt(clip.start)} · source ${fmt(media.duration)}`;
  if (document.activeElement !== $('start-input')) $('start-input').value = fmt(clip.in);
  if (document.activeElement !== $('end-input')) $('end-input').value = fmt(clip.out);
  $('start-input').classList.remove('invalid');
  $('end-input').classList.remove('invalid');

  const fadeMax = Math.max(MIN_CLIP, Math.min(5, len));
  for (const [id, value] of [['fade-in', clip.fadeIn], ['fade-out', clip.fadeOut]]) {
    $(id).max = String(Math.round(fadeMax * 10) / 10);
    $(id).value = String(value);
    $(`${id}-val`).textContent = `${value.toFixed(1)} s`;
  }
  $('speed').value = String(clip.speed);
  $('speed-val').textContent = `${clip.speed.toFixed(2)}×`;

  $('volume').value = String(Math.round(clip.volume * 100));
  $('volume-val').textContent = `${Math.round(clip.volume * 100)}%`;
  $('mute').classList.toggle('is-muted', clip.volume === 0);
  for (const id of ['volume', 'mute']) $(id).disabled = !media.hasAudio;
  $('audio-note').hidden = media.hasAudio;
}

// Slider drags are one undo step: remember the state at the first change, record it on release.
let effectBefore = null;

function bindSlider(id, apply) {
  const input = $(id);
  input.addEventListener('input', () => {
    const clip = selectedClip();
    if (!clip || state.busy) return;
    if (effectBefore === null) effectBefore = snap();
    apply(clip, Number(input.value));
    layoutCache = null;
    renderTimeline();
    renderProps();
    syncPlayers();
  });
  input.addEventListener('change', () => {
    if (effectBefore !== null && effectBefore !== snap()) recordUndo(effectBefore);
    effectBefore = null;
    input.blur();
    updateButtons();
  });
}

bindSlider('fade-in', (clip, v) => { clip.fadeIn = v; });
bindSlider('fade-out', (clip, v) => { clip.fadeOut = v; });
bindSlider('volume', (clip, v) => { clip.volume = v / 100; });
bindSlider('speed', (clip, v) => {
  // Slowing a clip makes it longer; never let it run into the next clip on its line.
  const { nextStart } = neighbours(clip);
  const slowest = Number.isFinite(nextStart) ? (clip.out - clip.in) / (nextStart - clip.start) : 0.5;
  clip.speed = Math.max(v, slowest, 0.5);
});

$('mute').addEventListener('click', () => {
  const clip = selectedClip();
  if (!clip) return;
  edit(() => {
    if (clip.volume === 0) clip.volume = clip.volumeBeforeMute || 1;
    else {
      clip.volumeBeforeMute = clip.volume;
      clip.volume = 0;
    }
  });
});

for (const [id, edge] of [['start-input', 'start'], ['end-input', 'end']]) {
  const input = $(id);
  const commit = () => {
    const clip = selectedClip();
    const t = parseTime(input.value);
    if (!clip || t === null) {
      input.classList.add('invalid');
      return;
    }
    const orig = { in: clip.in, out: clip.out, start: clip.start };
    edit(() => (edge === 'start' ? trimStartTo(clip, orig, t) : trimEndTo(clip, orig, t)));
    input.blur();
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  input.addEventListener('blur', renderProps);
}

$('props-close').addEventListener('click', () => {
  state.selectedId = null;
  updateSelection();
  renderProps();
  updateButtons();
});

/* ---------- Export ---------- */

const toast = $('toast');
let toastTimer = null;
let revealPath = null;

function showToast(message, { kind = '', progress = null, cancel = false, reveal = null, close = false, autoHide = 0 } = {}) {
  clearTimeout(toastTimer);
  toast.hidden = false;
  toast.className = kind;
  $('toast-msg').textContent = message;
  $('toast-bar').hidden = progress === null;
  if (progress !== null) $('toast-fill').style.width = `${Math.round(progress * 100)}%`;
  $('toast-cancel').hidden = !cancel;
  revealPath = reveal;
  $('toast-reveal').hidden = !reveal;
  $('toast-close').hidden = !close;
  if (autoHide) toastTimer = setTimeout(hideToast, autoHide);
}

function hideToast() {
  clearTimeout(toastTimer);
  toast.hidden = true;
}

$('toast-close').addEventListener('click', hideToast);
$('toast-cancel').addEventListener('click', () => window.api.cancel());
$('toast-reveal').addEventListener('click', () => revealPath && window.api.reveal(revealPath));

window.api.onProgress((fraction) => {
  if (!state.busy) return;
  showToast(`Exporting… ${Math.round(fraction * 100)}%`, { progress: fraction, cancel: true });
});

function setBusy(on) {
  state.busy = on;
  $('app').classList.toggle('exporting', on);
  updateButtons();
}

async function exportProject(mode) {
  if (!state.clips.length || state.busy || importing) return;
  pause();
  setBusy(true);
  showToast('Choose where to save the video…', { progress: 0, cancel: true });

  const result = await window.api.exportVideo({
    mode,
    clips: state.clips.map((c) => ({
      mediaId: c.mediaId,
      layer: state.tracks.indexOf(c.track),
      start: c.start,
      in: c.in,
      out: c.out,
      speed: c.speed,
      volume: c.volume,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
    })),
  });

  setBusy(false);
  if (result.ok) {
    const how = result.method === 'copy' ? 'lossless, no re-encode' : 're-encoded';
    showToast(`Exported (${how}):\n${result.output}`, { kind: 'ok', reveal: result.output, close: true });
  } else if (result.canceled) {
    showToast('Export canceled.', { close: true, autoHide: 3000 });
  } else {
    showToast(result.error, { kind: 'error', close: true });
  }
}

const exportMenu = $('export-menu');

function toggleExportMenu(open = exportMenu.hidden) {
  exportMenu.hidden = !open;
  $('export').setAttribute('aria-expanded', String(open));
}

$('export').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleExportMenu();
});
exportMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-mode]');
  if (!item) return;
  toggleExportMenu(false);
  exportProject(item.dataset.mode);
});
document.addEventListener('click', (e) => {
  if (!exportMenu.hidden && !e.target.closest('.menu-wrap')) toggleExportMenu(false);
  e.target.closest('button')?.blur(); // keep Space/Enter shortcuts working after a click
});

/* ---------- Toolbar + keyboard ---------- */

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('split').addEventListener('click', splitAtPlayhead);
$('delete').addEventListener('click', () => deleteSelected());
$('play').addEventListener('click', togglePlay);
$('to-start').addEventListener('click', () => seekTo(0));
$('back10').addEventListener('click', () => skip(-10));
$('fwd10').addEventListener('click', () => skip(10));
canvas.addEventListener('click', togglePlay);
$('fullscreen').addEventListener('click', () => $('stage').requestFullscreen?.());

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input:not([type="range"]), select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && key === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (mod || state.busy) return;
  const step = e.shiftKey ? FRAME : 10;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); skip(-step); break;
    case 'ArrowRight': e.preventDefault(); skip(step); break;
    case 'Home': seekTo(0); break;
    case 'End': seekTo(layout().total); break;
    case 'Delete': case 'Backspace': deleteSelected(!e.shiftKey); break;
    case 'Escape': toggleExportMenu(false); break;
    default:
      if (key === 'j') skip(-10);
      else if (key === 'l') skip(10);
      else if (key === 's') splitAtPlayhead();
      else if (key === 'i') trimToPlayhead('start');
      else if (key === 'o') trimToPlayhead('end');
  }
});

window.addEventListener('resize', () => {
  renderTimeline();
  fitCanvas();
});

/* ---------- Start ---------- */

renderMedia();
renderTimeline();
renderProps();
updateButtons();
requestAnimationFrame(frame);
