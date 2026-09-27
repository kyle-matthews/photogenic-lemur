-- Run on every start; every statement must be safe to re-run.

create table if not exists photos (
  id            text primary key,
  seq           integer unique,        -- assigned when the upload finishes; orders the album
  uploader_id   text not null,         -- anonymous per-browser id so guests can remove their own photos
  guest_name    text,
  original_name text,
  content_type  text not null,
  size_bytes    integer not null,
  width         integer,
  height        integer,
  has_preview   integer not null default 0,
  created_at    text not null,         -- ISO 8601, UTC
  completed_at  text
);

-- Hands out album positions. Numbers are never reused, even after a photo is removed, so a
-- guest asking for "anything after N" can't miss a photo.
create table if not exists counters (
  name  text primary key,
  value integer not null
);
insert or ignore into counters (name, value) values ('photo_seq', 0);
