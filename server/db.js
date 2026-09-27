import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// One small SQLite file holds the photo list. The API is synchronous, and a single app process
// is the only writer, so each function below runs without interleaving with other requests.
mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'album.db'));
db.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000;');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

const sql = {
  insert: db.prepare(`
    insert into photos (id, uploader_id, guest_name, original_name, content_type, size_bytes,
                        width, height, has_preview, created_at)
    values (:id, :uploader_id, :guest_name, :original_name, :content_type, :size_bytes,
            :width, :height, :has_preview, :created_at)`),
  get: db.prepare('select * from photos where id = ?'),
  nextSeq: db.prepare("update counters set value = value + 1 where name = 'photo_seq' returning value"),
  complete: db.prepare('update photos set seq = ?, completed_at = ? where id = ? returning *'),
  newest: db.prepare('select * from photos where seq is not null order by seq desc limit ?'),
  before: db.prepare('select * from photos where seq is not null and seq < ? order by seq desc limit ?'),
  after: db.prepare('select * from photos where seq > ? order by seq asc limit ?'),
  count: db.prepare('select count(*) as count from photos where seq is not null'),
  delete: db.prepare('delete from photos where id = ?'),
};

export function createPhoto(photo) {
  sql.insert.run({ ...photo, has_preview: photo.has_preview ? 1 : 0, created_at: new Date().toISOString() });
}

export function getPhoto(id) {
  return sql.get.get(id);
}

/** Marks an upload as finished, which is what makes it appear in the album. Safe to call twice. */
export function completePhoto(id) {
  const photo = getPhoto(id);
  if (!photo || photo.seq !== null) return photo;
  const { value } = sql.nextSeq.get();
  return sql.complete.get(value, new Date().toISOString(), id);
}

/** Newest first, or oldest first when polling for photos added after `after`. */
export function listPhotos({ before, after, limit }) {
  if (after != null) return sql.after.all(after, limit);
  if (before != null) return sql.before.all(before, limit);
  return sql.newest.all(limit);
}

export function countPhotos() {
  return sql.count.get().count;
}

export function deletePhoto(id) {
  sql.delete.run(id);
}
