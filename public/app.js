// The guest-facing album: access gate, uploads, the live gallery and the photo viewer.

const $ = (id) => document.getElementById(id);

const el = {
  adminBar: $('admin-bar'),
  signOut: $('sign-out'),
  gate: $('gate'),
  gateForm: $('gate-form'),
  gateCode: $('gate-code'),
  gateError: $('gate-error'),
  upload: $('upload'),
  guestName: $('guest-name'),
  fileInput: $('file-input'),
  queueHead: $('queue-head'),
  queueSummary: $('queue-summary'),
  clearDone: $('clear-done'),
  queue: $('queue'),
  album: $('album'),
  grid: $('grid'),
  empty: $('empty'),
  albumStatus: $('album-status'),
  count: $('photo-count'),
  sentinel: $('sentinel'),
  viewer: $('viewer'),
  viewerStage: $('viewer-stage'),
  viewerImg: $('viewer-img'),
  viewerMissing: $('viewer-missing'),
  viewerCount: $('viewer-count'),
  viewerFrom: $('viewer-from'),
  viewerTime: $('viewer-time'),
  viewerPrev: $('viewer-prev'),
  viewerNext: $('viewer-next'),
  viewerClose: $('viewer-close'),
  viewerDownload: $('viewer-download'),
  viewerRemove: $('viewer-remove'),
  toast: $('toast'),
};

const PARALLEL_UPLOADS = 2;
const RETRY_DELAYS_MS = [2000, 6000];
const POLL_INTERVAL_MS = 15000;
const PREVIEW_LONG_EDGE = 1600;
const THUMB_SHORT_EDGE = 400;
const THUMB_LONG_EDGE_MAX = 1200;

const TYPES_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
};
const ACCEPTED_TYPES = new Set(Object.values(TYPES_BY_EXTENSION));

const CAMERA_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 8.5a2 2 0 0 1 2-2h2.3l1.6-2.5h5.2l1.6 2.5h2.3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.5"/></svg>';
const CHECK_ICON = '<svg class="q-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const timeFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

const state = {
  admin: false,
  ready: false,       // true once the first page of the album has loaded
  photos: [],         // newest first
  tiles: new Map(),   // photo id -> tile element
  newestSeq: 0,       // polling asks for anything added after this
  oldestSeq: null,    // infinite scroll asks for anything before this
  hasMore: true,
  loading: false,
  polling: false,
  total: 0,
};

// --- Small helpers ------------------------------------------------------------

const saved = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: nothing to do */ }
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mediaUrl = (kind, id) => `/media/${kind}/${id}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status; // 0 means the request never got a response
  }

  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

async function api(method, path, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Couldn’t reach the album. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Something went wrong (${res.status}).`);
  return data;
}

async function withRetries(task, onRetry) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (!err.retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      onRetry?.();
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 5000);
}

// --- Session and gate -----------------------------------------------------------

async function start() {
  el.guestName.value = saved.get('guestName') ?? '';
  try {
    const session = await api('GET', '/api/session');
    if (session.guest) openAlbum(session);
    else showGate();
  } catch (err) {
    toast(err.message);
    setTimeout(start, 4000);
  }
}

function showGate() {
  el.gate.hidden = false;
  if (new URLSearchParams(location.search).has('invalid')) {
    showGateError('That code didn’t work. Check it and try again.');
  }
}

function showGateError(message) {
  el.gateError.textContent = message;
  el.gateError.hidden = false;
}

el.gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.gateError.hidden = true;
  try {
    const session = await api('POST', '/api/session', { code: el.gateCode.value });
    el.gate.hidden = true;
    openAlbum(session);
  } catch (err) {
    showGateError(err.message);
  }
});

el.signOut.addEventListener('click', async () => {
  await api('DELETE', '/api/session').catch(() => {});
  location.reload();
});

function openAlbum(session) {
  state.admin = session.admin;
  el.adminBar.hidden = !session.admin;
  el.upload.hidden = false;
  el.album.hidden = false;
  if (location.search) history.replaceState(null, '', '/');

  loadOlder();
  new IntersectionObserver(([entry]) => entry.isIntersecting && loadOlder(), { rootMargin: '800px 0px' })
    .observe(el.sentinel);
  setInterval(pollNewer, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => !document.hidden && pollNewer());
}

// --- Album ------------------------------------------------------------------------

async function loadOlder() {
  if (state.loading || !state.hasMore) return;
  state.loading = true;
  let failed = false;
  try {
    const data = await api('GET', `/api/photos${state.oldestSeq ? `?before=${state.oldestSeq}` : ''}`);
    state.hasMore = data.hasMore;
    state.ready = true;
    track(data);
    addPhotos(data.photos);
    el.albumStatus.hidden = true;
  } catch (err) {
    failed = true;
    el.albumStatus.textContent = `${err.message} Trying again…`;
    el.albumStatus.hidden = false;
  } finally {
    state.loading = false;
  }
  if (failed) setTimeout(loadOlder, 5000);
  else if (state.hasMore && el.sentinel.getBoundingClientRect().top < innerHeight + 800) loadOlder();
}

async function pollNewer() {
  if (!state.ready || state.polling || document.hidden) return;
  state.polling = true;
  try {
    let more = true;
    while (more) {
      const data = await api('GET', `/api/photos?after=${state.newestSeq}&limit=100`);
      track(data);
      addPhotos(data.photos, { fresh: true });
      more = data.hasMore;
    }
  } catch {
    // The next poll will catch up.
  } finally {
    state.polling = false;
  }
}

function track({ photos, total }) {
  for (const { seq } of photos) {
    state.newestSeq = Math.max(state.newestSeq, seq);
    state.oldestSeq = Math.min(state.oldestSeq ?? seq, seq);
  }
  setTotal(total);
}

function setTotal(total) {
  state.total = total;
  el.count.textContent = plural(total, 'photo');
}

/** Inserts photos in album order (newest first), skipping any already shown. Returns how many were new. */
function addPhotos(photos, { fresh = false } = {}) {
  let added = 0;
  for (const photo of photos) {
    if (state.tiles.has(photo.id)) continue;
    let index = state.photos.findIndex((p) => p.seq < photo.seq);
    if (index === -1) index = state.photos.length;
    const tile = createTile(photo, fresh);
    state.photos.splice(index, 0, photo);
    state.tiles.set(photo.id, tile);
    el.grid.insertBefore(tile, el.grid.children[index] ?? null);
    added++;
  }
  albumChanged();
  return added;
}

function removePhoto(id) {
  const index = state.photos.findIndex((p) => p.id === id);
  if (index === -1) return;
  state.photos.splice(index, 1);
  state.tiles.get(id)?.remove();
  state.tiles.delete(id);
  setTotal(Math.max(0, state.total - 1));
  albumChanged();
}

function albumChanged() {
  el.empty.hidden = !state.ready || state.photos.length > 0;
  upgradeFeaturedTile();
  if (el.viewer.open) updateViewerChrome();
}

function createTile(photo, fresh) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = fresh ? 'tile is-new' : 'tile';
  tile.dataset.id = photo.id;
  tile.setAttribute('aria-label', photo.guestName ? `Photo from ${photo.guestName}` : 'Photo');
  if (photo.hasPreview) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
    img.src = mediaUrl('thumb', photo.id);
    tile.append(img);
  } else {
    tile.insertAdjacentHTML('beforeend', `<span class="tile-missing">${CAMERA_ICON}</span>`);
  }
  tile.addEventListener('click', () => openViewer(photo.id));
  return tile;
}

/**
 * The first tile is shown twice as large, so it gets the sharper preview image. Waits for the
 * album to settle, so a burst of new photos doesn't fetch a preview for each one, and hands
 * the previous featured tile back its small thumbnail.
 */
let sharpTile = null;
let sharpTimer;
function upgradeFeaturedTile() {
  clearTimeout(sharpTimer);
  sharpTimer = setTimeout(() => {
    const tile = el.grid.firstElementChild;
    if (tile === sharpTile) return;
    sharpTile?.querySelector('img')?.setAttribute('src', mediaUrl('thumb', sharpTile.dataset.id));
    sharpTile = tile;
    const img = tile?.querySelector('img');
    if (!img) return;
    const sharp = new Image();
    sharp.src = mediaUrl('preview', tile.dataset.id);
    sharp.decode().then(() => { if (sharpTile === tile) img.src = sharp.src; }, () => {});
  }, 1500);
}

// --- Uploads ------------------------------------------------------------------------

const queue = [];
let activeUploads = 0;

el.guestName.addEventListener('input', () => saved.set('guestName', el.guestName.value.trim()));

el.fileInput.addEventListener('change', () => {
  const files = [...el.fileInput.files];
  el.fileInput.value = ''; // so choosing the same photos again still triggers a change
  const photos = files.filter((file) => ACCEPTED_TYPES.has(typeOf(file)));
  const skipped = files.length - photos.length;
  if (skipped) toast(`${skipped === 1 ? 'One file was' : `${skipped} files were`} skipped. Only photos can be added.`);
  photos.forEach(enqueue);
  pumpQueue();
});

el.clearDone.addEventListener('click', () => {
  for (const item of queue.filter((i) => i.status === 'done')) {
    item.el.remove();
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    queue.splice(queue.indexOf(item), 1);
  }
  updateQueueSummary();
});

function typeOf(file) {
  const type = file.type.toLowerCase();
  if (type) return type === 'image/jpg' ? 'image/jpeg' : type;
  return TYPES_BY_EXTENSION[file.name.split('.').pop().toLowerCase()] ?? '';
}

function enqueue(file) {
  const item = { file, type: typeOf(file), status: 'waiting', photoId: null, previews: undefined, thumbUrl: null };
  item.el = document.createElement('li');
  item.el.innerHTML = '<span class="q-thumb"></span><div><p class="q-status"></p><div class="q-bar"><i></i></div></div><span></span>';
  queue.push(item);
  el.queue.append(item.el);
  setItem(item, 'waiting', 'Waiting…');
}

function setItem(item, status, message) {
  item.status = status;
  item.el.className = `q-item is-${status}`;
  item.el.querySelector('.q-status').textContent = message;
  const end = item.el.lastElementChild;
  end.replaceChildren();
  if (status === 'done') end.innerHTML = CHECK_ICON;
  if (status === 'failed') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'q-action';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => {
      setItem(item, 'waiting', 'Waiting…');
      pumpQueue();
    });
    end.append(retry);
  }
  if (status !== 'working') setProgress(item, status === 'done' ? 1 : 0);
  updateQueueSummary();
}

function setProgress(item, fraction) {
  item.el.querySelector('.q-bar i').style.setProperty('--progress', fraction);
}

function pumpQueue() {
  while (activeUploads < PARALLEL_UPLOADS) {
    const item = queue.find((i) => i.status === 'waiting');
    if (!item) break;
    activeUploads++;
    uploadItem(item).finally(() => {
      activeUploads--;
      pumpQueue();
    });
  }
}

async function uploadItem(item) {
  const onRetry = () => setItem(item, 'working', 'Weak signal, trying again…');
  try {
    if (item.previews === undefined) {
      setItem(item, 'working', 'Preparing…');
      item.previews = await oneAtATime(() => makePreviews(item.file)).catch(() => null);
      const thumb = item.el.querySelector('.q-thumb');
      if (item.previews) {
        item.thumbUrl = URL.createObjectURL(item.previews.thumb);
        thumb.style.backgroundImage = `url("${item.thumbUrl}")`;
      } else {
        thumb.innerHTML = CAMERA_ICON;
      }
    }
    if (!item.photoId) {
      setItem(item, 'working', 'Uploading…');
      ({ id: item.photoId } = await withRetries(() => api('POST', '/api/photos', detailsForm(item)), onRetry));
    }
    setItem(item, 'working', 'Uploading…');
    const { photo } = await withRetries(() => sendOriginal(item), onRetry);
    item.previews = null;
    setItem(item, 'done', 'In the album');
    if (addPhotos([photo], { fresh: true })) setTotal(state.total + 1);
  } catch (err) {
    item.retryable = Boolean(err.retryable);
    setItem(item, 'failed', err.message);
  }
}

function detailsForm(item) {
  const form = new FormData();
  form.set('type', item.type);
  form.set('size', String(item.file.size));
  form.set('name', item.file.name);
  form.set('guestName', el.guestName.value.trim());
  if (item.previews) {
    form.set('width', String(item.previews.width));
    form.set('height', String(item.previews.height));
    form.set('thumb', item.previews.thumb, 'thumb.jpg');
    form.set('preview', item.previews.preview, 'preview.jpg');
  }
  return form;
}

/** Streams the full-size file with progress (fetch can't report upload progress). */
function sendOriginal(item) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/photos/${item.photoId}/original`);
    xhr.setRequestHeader('Content-Type', item.type);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const fraction = event.loaded / event.total;
      setProgress(item, fraction);
      item.el.querySelector('.q-status').textContent = `Uploading… ${Math.round(fraction * 100)}%`;
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.photo) resolve(xhr.response);
      else reject(new ApiError(xhr.status, xhr.response?.error || `Upload failed (${xhr.status}).`));
    });
    xhr.addEventListener('error', () => reject(new ApiError(0, 'The connection dropped.')));
    xhr.addEventListener('abort', () => reject(new ApiError(0, 'The upload was cancelled.')));
    xhr.send(item.file);
  });
}

// Decoding full-size photos is memory hungry on phones, so make previews one at a time.
let previewChain = Promise.resolve();
function oneAtATime(task) {
  const run = previewChain.then(task);
  previewChain = run.catch(() => {});
  return run;
}

/**
 * Makes the small JPEGs the album displays, so the server never has to process images.
 * Rejects for formats this browser can't decode (e.g. HEIC outside Safari); the original
 * still uploads and shows as a placeholder tile.
 */
async function makePreviews(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const { naturalWidth: width, naturalHeight: height } = img;
    const preview = drawScaled(img, width, height, Math.min(1, PREVIEW_LONG_EDGE / Math.max(width, height)));
    const thumb = drawScaled(preview, preview.width, preview.height, Math.min(
      1,
      THUMB_SHORT_EDGE / Math.min(preview.width, preview.height),
      THUMB_LONG_EDGE_MAX / Math.max(preview.width, preview.height),
    ));
    const [previewBlob, thumbBlob] = await Promise.all([toJpeg(preview, 0.82), toJpeg(thumb, 0.8)]);
    for (const canvas of [preview, thumb]) canvas.width = canvas.height = 0; // frees memory promptly on iOS
    return { width, height, preview: previewBlob, thumb: thumbBlob };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawScaled(source, width, height, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode preview'))), 'image/jpeg', quality);
  });
}

function updateQueueSummary() {
  const total = queue.length;
  const done = queue.filter((i) => i.status === 'done').length;
  const failed = queue.filter((i) => i.status === 'failed').length;
  const pending = total - done - failed;

  el.queueHead.hidden = total === 0;
  el.clearDone.hidden = done === 0 || pending > 0;
  el.upload.classList.toggle('is-busy', pending > 0);
  el.queueSummary.textContent = pending
    ? `${done} of ${plural(total, 'photo')} added…`
    : failed
      ? `${failed} couldn’t be added. Tap Retry to try again.`
      : total === 1
        ? 'Your photo is in the album. Thank you!'
        : `All ${total} photos are in the album. Thank you!`;
  keepAwake(pending > 0);
}

// Pick up where we left off when the signal comes back or the guest returns to the tab.
function resumeFailed() {
  const stalled = queue.filter((i) => i.status === 'failed' && i.retryable);
  for (const item of stalled) setItem(item, 'waiting', 'Waiting…');
  if (stalled.length) pumpQueue();
}
window.addEventListener('online', resumeFailed);
document.addEventListener('visibilitychange', () => !document.hidden && resumeFailed());

window.addEventListener('beforeunload', (event) => {
  if (queue.some((i) => i.status === 'waiting' || i.status === 'working')) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// Stop the phone going to sleep (which pauses uploads) while photos are still sending.
let wakeLock = null;
let wantAwake = false;
async function keepAwake(on) {
  wantAwake = on;
  if (!('wakeLock' in navigator)) return;
  try {
    if (on && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = navigator.wakeLock.request('screen');
      const lock = await wakeLock;
      lock.addEventListener('release', () => { wakeLock = null; });
      if (!wantAwake) lock.release();
    } else if (!on && wakeLock) {
      (await wakeLock).release();
    }
  } catch {
    wakeLock = null; // not allowed right now (e.g. low-power mode); uploads still work
  }
}
document.addEventListener('visibilitychange', () => !document.hidden && wantAwake && keepAwake(true));

// --- Viewer -------------------------------------------------------------------------

let viewerId = null;
let armedTimer;
let swipeStart = null;

const viewerIndex = () => state.photos.findIndex((p) => p.id === viewerId);

function openViewer(id) {
  viewerId = id;
  showInViewer();
  if (!el.viewer.open) {
    el.viewer.showModal();
    document.documentElement.classList.add('is-locked');
  }
}

function step(delta) {
  const next = state.photos[viewerIndex() + delta];
  if (!next) return;
  viewerId = next.id;
  showInViewer();
}

function showInViewer() {
  const index = viewerIndex();
  const photo = state.photos[index];
  if (!photo) return el.viewer.close();

  el.viewerImg.hidden = !photo.hasPreview;
  el.viewerMissing.hidden = photo.hasPreview;
  if (photo.hasPreview) {
    el.viewerImg.src = mediaUrl('thumb', photo.id); // usually cached, so something shows instantly
    const sharp = new Image();
    sharp.src = mediaUrl('preview', photo.id);
    sharp.decode().then(() => { if (viewerId === photo.id) el.viewerImg.src = sharp.src; }, () => {});
  }
  el.viewerImg.alt = photo.guestName ? `Photo from ${photo.guestName}` : 'Wedding photo';
  el.viewerFrom.textContent = photo.guestName ? `From ${photo.guestName}` : 'From a guest';
  el.viewerTime.textContent = photo.addedAt ? timeFormat.format(new Date(photo.addedAt)) : '';
  el.viewerDownload.href = mediaUrl('original', photo.id);
  el.viewerRemove.hidden = !(photo.mine || state.admin);
  disarmRemove();
  updateViewerChrome();

  for (const neighbour of [state.photos[index + 1], state.photos[index - 1]]) {
    if (neighbour?.hasPreview) new Image().src = mediaUrl('preview', neighbour.id);
  }
  if (index > state.photos.length - 6) loadOlder();
}

function updateViewerChrome() {
  const index = viewerIndex();
  el.viewerCount.textContent = `${index + 1} of ${Math.max(state.total, state.photos.length)}`;
  el.viewerPrev.disabled = index <= 0;
  el.viewerNext.disabled = index >= state.photos.length - 1;
}

function disarmRemove() {
  clearTimeout(armedTimer);
  el.viewerRemove.classList.remove('is-armed');
  el.viewerRemove.textContent = 'Remove';
}

el.viewerRemove.addEventListener('click', async () => {
  if (!el.viewerRemove.classList.contains('is-armed')) {
    el.viewerRemove.classList.add('is-armed');
    el.viewerRemove.textContent = 'Tap again to remove';
    armedTimer = setTimeout(disarmRemove, 4000);
    return;
  }
  disarmRemove();
  const id = viewerId;
  const index = viewerIndex();
  try {
    await api('DELETE', `/api/photos/${id}`);
    toast('Photo removed.');
  } catch (err) {
    if (err.status !== 404) return toast(err.message);
  }
  removePhoto(id);
  const next = state.photos[index] ?? state.photos[index - 1];
  if (next) openViewer(next.id);
  else el.viewer.close();
});

el.viewerClose.addEventListener('click', () => el.viewer.close());
el.viewerPrev.addEventListener('click', () => step(-1));
el.viewerNext.addEventListener('click', () => step(1));
el.viewer.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') step(-1);
  if (event.key === 'ArrowRight') step(1);
});
el.viewer.addEventListener('close', () => {
  document.documentElement.classList.remove('is-locked');
  disarmRemove();
});

// Swipe sideways to move between photos, swipe down (or tap the dark area) to close.
el.viewerStage.addEventListener('pointerdown', (event) => {
  swipeStart = event.isPrimary ? { x: event.clientX, y: event.clientY } : null;
});
el.viewerStage.addEventListener('pointercancel', () => { swipeStart = null; });
el.viewerStage.addEventListener('pointerup', (event) => {
  if (!swipeStart || !event.isPrimary) return;
  const dx = event.clientX - swipeStart.x;
  const dy = event.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) step(dx < 0 ? 1 : -1);
  else if (dy > 90 && dy > Math.abs(dx) * 1.4) el.viewer.close();
  else if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && event.target === el.viewerStage) el.viewer.close();
});

start();
