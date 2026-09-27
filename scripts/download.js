// Downloads every photo in the album, full size, into a folder. It goes through the album
// itself, so all it needs is the address and your code (GUEST_CODE or ADMIN_CODE from .env).
// Safe to re-run: photos already downloaded are skipped.
// Usage: npm run download -- https://your-album.fly.dev [folder]
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [address, folder = 'wedding-photos'] = process.argv.slice(2);
if (!address) fail('Usage: npm run download -- https://your-album.fly.dev [folder]');

const album = new URL(address);
let cookie = '';

const code = process.env.ADMIN_CODE || process.env.GUEST_CODE;
if (code) {
  const res = await request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const photos = [];
for (let before = ''; ; ) {
  const page = await (await request(`/api/photos?limit=200${before}`)).json();
  photos.push(...page.photos);
  if (!page.hasMore) break;
  before = `&before=${page.photos.at(-1).seq}`;
}
photos.reverse(); // oldest first

const outDir = path.resolve(folder);
await mkdir(outDir, { recursive: true });
const existing = new Set(
  (await readdir(outDir)).filter((name) => !name.endsWith('.part')).map((name) => name.replace(/\.[^.]+$/, '')),
);
console.log(`${photos.length} photos in the album. Saving to ${outDir}`);

let saved = 0;
let skipped = 0;
let failed = 0;
for (const [index, photo] of photos.entries()) {
  const base = fileBase(photo);
  if (existing.has(base)) {
    skipped++;
    continue;
  }
  try {
    const res = await request(`/media/original/${photo.id}`);
    const ext = res.headers.get('content-disposition')?.match(/\.(\w+)"/)?.[1] ?? 'jpg';
    const partial = path.join(outDir, `${base}.part`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
    await rename(partial, path.join(outDir, `${base}.${ext}`));
    saved++;
    process.stdout.write(`\r${index + 1} / ${photos.length}`);
  } catch (err) {
    failed++;
    console.error(`\nCouldn't download ${photo.id}: ${err.message}`);
  }
}
console.log(`\nDone: ${saved} saved, ${skipped} already there, ${failed} failed.`);

async function request(pathname, init = {}) {
  const res = await fetch(new URL(pathname, album), { ...init, headers: { cookie, ...init.headers } });
  if (res.status === 401) fail('The album needs a code: set GUEST_CODE or ADMIN_CODE in .env to match the live album.');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

/** e.g. "2027-06-12 20.41.33 Auntie Jo 1a2b3c4d", using this computer's time zone. */
function fileBase(photo) {
  const d = new Date(photo.addedAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  const who = (photo.guestName ?? '').replace(/[^\p{L}\p{N} '-]+/gu, '').trim().slice(0, 40) || 'Guest';
  return `${stamp} ${who} ${photo.id.slice(0, 8)}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
