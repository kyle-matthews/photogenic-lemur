import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline, Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config.js';
import * as db from './db.js';
import * as storage from './storage.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
const MEDIA_KINDS = ['thumb', 'preview', 'original'];

const COOKIES = { guest: 'album_guest', admin: 'album_admin', uid: 'album_uid' };
const cookieOptions = {
  httpOnly: true,
  sameSite: 'Lax',
  secure: config.production,
  path: '/',
  maxAge: 60 * 60 * 24 * 365,
};

// --- Access -----------------------------------------------------------------

function codeMatches(value, code) {
  if (!value || !code) return false;
  const a = Buffer.from(String(value).trim().toUpperCase());
  const b = Buffer.from(code.trim().toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

const isAdmin = (c) => codeMatches(getCookie(c, COOKIES.admin), config.adminCode);
const isGuest = (c) =>
  !config.guestCode || isAdmin(c) || codeMatches(getCookie(c, COOKIES.guest), config.guestCode);

/** Exchanges a code for cookies. Returns 'admin', 'guest', or null when the code is wrong. */
function signIn(c, code) {
  const role = codeMatches(code, config.adminCode) ? 'admin' : codeMatches(code, config.guestCode) ? 'guest' : null;
  if (role === 'admin') setCookie(c, COOKIES.admin, config.adminCode, cookieOptions);
  if (role && config.guestCode) setCookie(c, COOKIES.guest, config.guestCode, cookieOptions);
  return role;
}

async function requireGuest(c, next) {
  if (!isGuest(c)) return c.json({ error: 'This album is private. Scan the QR code to get in.' }, 401);
  await next();
}

// Fly terminates TLS in front of the app, so compare hosts rather than full origins.
function sameHost(origin, c) {
  try {
    return new URL(origin).host === c.req.header('host');
  } catch {
    return false;
  }
}

// --- Helpers ----------------------------------------------------------------

function toPublic(row, c) {
  return {
    id: row.id,
    seq: row.seq,
    guestName: row.guest_name,
    width: row.width,
    height: row.height,
    hasPreview: Boolean(row.has_preview),
    addedAt: row.completed_at,
    mine: row.uploader_id === c.get('uid'),
  };
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  return value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength) || null;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const isJpeg = (value) =>
  value instanceof Blob && value.type === 'image/jpeg' && value.size > 0 && value.size <= PREVIEW_MAX_BYTES;

function downloadDisposition(photo) {
  const ext = storage.EXTENSIONS[photo.content_type] ?? 'bin';
  const who = (photo.guest_name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const name = ['wedding', who, photo.id.slice(0, 8)].filter(Boolean).join('-') + '.' + ext;
  const ascii = name.replace(/[^\w.-]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

class UploadInterrupted extends Error {}

/** Passes a stream through, failing unless it is exactly `expected` bytes long. */
function exactLength(expected) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      callback(seen > expected ? new UploadInterrupted('larger than declared') : null, chunk);
    },
    flush(callback) {
      callback(seen === expected ? null : new UploadInterrupted(`ended after ${seen} of ${expected} bytes`));
    },
  });
}

// --- App --------------------------------------------------------------------

const app = new Hono();

app.use('*', secureHeaders());
app.use('/api/*', csrf({ origin: sameHost }));

// Every browser gets an anonymous id, so guests can remove the photos they added.
app.use('/api/*', async (c, next) => {
  let uid = getCookie(c, COOKIES.uid);
  if (!uid || !UUID_RE.test(uid)) {
    uid = randomUUID();
    setCookie(c, COOKIES.uid, uid, cookieOptions);
  }
  c.set('uid', uid);
  await next();
});

app.get('/healthz', (c) => c.text('ok'));

// The QR code points at /?code=..., which signs the guest in and tidies the URL.
app.get('/', async (c, next) => {
  const code = c.req.query('code');
  if (code === undefined) return next();
  return c.redirect(signIn(c, code) ? '/' : '/?invalid');
});

app.get('/api/session', (c) => c.json({ guest: isGuest(c), admin: isAdmin(c) }));

app.post('/api/session', async (c) => {
  const { code } = await c.req.json().catch(() => ({}));
  const role = signIn(c, code);
  if (!role) return c.json({ error: "That code didn't work. Check it and try again." }, 401);
  return c.json({ guest: true, admin: role === 'admin' });
});

app.delete('/api/session', (c) => {
  deleteCookie(c, COOKIES.admin, { path: '/' });
  return c.json({ guest: isGuest(c), admin: false });
});

app.get('/api/photos', requireGuest, async (c) => {
  const before = positiveInt(c.req.query('before'));
  const after = c.req.query('after') === undefined ? null : Number(c.req.query('after')) || 0;
  const limit = Math.min(positiveInt(c.req.query('limit')) ?? 60, 200);
  const rows = db.listPhotos({ before, after, limit: limit + 1 });
  return c.json({
    photos: rows.slice(0, limit).map((row) => toPublic(row, c)),
    hasMore: rows.length > limit,
    total: db.countPhotos(),
  });
});

// Step 1 of an upload: the browser sends details plus the small preview images it made,
// and gets back an id to upload the full-size original to.
app.post(
  '/api/photos',
  requireGuest,
  bodyLimit({
    maxSize: 2 * PREVIEW_MAX_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: 'That upload was too large.' }, 413),
  }),
  async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: 'Expected a form upload.' }, 400);

    const type = String(form.get('type') ?? '').toLowerCase();
    const contentType = type === 'image/jpg' ? 'image/jpeg' : type;
    const size = Number(form.get('size'));
    if (!storage.EXTENSIONS[contentType]) return c.json({ error: 'Only photos can be added to the album.' }, 415);
    if (!Number.isSafeInteger(size) || size <= 0) return c.json({ error: 'That file looks empty.' }, 400);
    if (size > config.maxUploadBytes) {
      return c.json({ error: `Photos need to be under ${config.maxUploadBytes / 1024 / 1024} MB.` }, 413);
    }

    const id = randomUUID();
    const thumb = form.get('thumb');
    const preview = form.get('preview');
    const hasPreview = isJpeg(thumb) && isJpeg(preview);
    if (hasPreview) {
      await Promise.all([
        storage.putObject(storage.keys.thumb(id), Buffer.from(await thumb.arrayBuffer()), { contentType: 'image/jpeg' }),
        storage.putObject(storage.keys.preview(id), Buffer.from(await preview.arrayBuffer()), { contentType: 'image/jpeg' }),
      ]);
    }

    db.createPhoto({
      id,
      uploader_id: c.get('uid'),
      guest_name: cleanText(form.get('guestName'), 60),
      original_name: cleanText(form.get('name'), 200),
      content_type: contentType,
      size_bytes: size,
      width: positiveInt(form.get('width')),
      height: positiveInt(form.get('height')),
      has_preview: hasPreview,
    });
    return c.json({ id }, 201);
  },
);

// Step 2: the original file, streamed straight through to storage. Finishing this step is
// what makes the photo appear in the album. Retrying after a success is harmless.
app.put('/api/photos/:id/original', requireGuest, async (c) => {
  const id = c.req.param('id');
  const photo = UUID_RE.test(id) ? db.getPhoto(id) : undefined;
  if (!photo || photo.uploader_id !== c.get('uid')) return c.json({ error: 'Upload not found.' }, 404);
  if (!c.req.raw.body) return c.json({ error: 'No file received.' }, 400);

  // The S3 client doesn't notice when its body stream fails (say, the guest's signal drops),
  // so abort the storage request ourselves instead of leaving it waiting for bytes.
  const abort = new AbortController();
  const size = Number(photo.size_bytes);
  const body = pipeline(Readable.fromWeb(c.req.raw.body), exactLength(size), (err) => {
    if (err) abort.abort(err instanceof UploadInterrupted ? err : new UploadInterrupted(err.message));
  });
  try {
    await storage.putObject(storage.keys.original(id, photo.content_type), body, {
      contentType: photo.content_type,
      contentLength: size,
      signal: abort.signal,
    });
  } catch (err) {
    throw abort.signal.aborted ? abort.signal.reason : err;
  }

  return c.json({ photo: toPublic(db.completePhoto(id), c) });
});

app.delete('/api/photos/:id', requireGuest, async (c) => {
  const id = c.req.param('id');
  const photo = UUID_RE.test(id) ? db.getPhoto(id) : undefined;
  if (!photo) return c.json({ error: 'That photo has already been removed.' }, 404);
  if (photo.uploader_id !== c.get('uid') && !isAdmin(c)) {
    return c.json({ error: 'You can only remove photos you added.' }, 403);
  }
  await storage.deleteObjects([
    storage.keys.original(id, photo.content_type),
    storage.keys.preview(id),
    storage.keys.thumb(id),
  ]);
  db.deletePhoto(id);
  return c.json({ ok: true });
});

app.get('/media/:kind/:id', requireGuest, async (c) => {
  const { kind, id } = c.req.param();
  if (!MEDIA_KINDS.includes(kind) || !UUID_RE.test(id)) return c.notFound();

  let key;
  let photo;
  if (kind === 'original') {
    photo = db.getPhoto(id);
    if (!photo?.seq) return c.notFound();
    key = storage.keys.original(id, photo.content_type);
  } else {
    key = storage.keys[kind](id);
  }

  const object = await storage.getObject(key);
  if (!object) return c.notFound();
  c.header('Content-Type', object.contentType || 'application/octet-stream');
  if (object.contentLength != null) c.header('Content-Length', String(object.contentLength));
  c.header('Cache-Control', 'private, max-age=31536000, immutable');
  if (photo) c.header('Content-Disposition', downloadDisposition(photo));
  return c.body(object.stream);
});

app.use(
  '*',
  serveStatic({
    root: PUBLIC_DIR,
    // Revalidate on every visit, so re-theming and redeploying shows up straight away.
    onFound: (_path, c) => c.header('Cache-Control', 'no-cache'),
  }),
);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof UploadInterrupted) {
    console.warn(`Upload interrupted: ${err.message}`);
    return c.json({ error: 'The upload was interrupted. Please try again.' }, 400);
  }
  console.error(err);
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});

// --- Start ------------------------------------------------------------------

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`Wedding album running at http://localhost:${port}`);
  console.log(`Photos are stored in ${storage.location}; the photo list in ${config.dataDir}`);
});

// Let in-flight uploads finish when Fly stops or redeploys the machine (see kill_timeout).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 25_000).unref();
  });
}
